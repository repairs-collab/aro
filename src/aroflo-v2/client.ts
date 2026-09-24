import type { AppConfig } from '../config.js';
import { redact } from '../redaction.js';
import { ConnectorError, type ConnectorErrorCode } from '../aroflo/errors.js';
import type { RequestBudget } from '../aroflo/rate-limiter.js';
import {
  encodeV2Query,
  type CreateInvoiceInput,
  type InvoiceLineListQuery,
  type InvoiceLinePatch,
  type InvoiceListQuery
} from './contracts.js';

export interface AroFloV2ClientOptions {
  config: AppConfig;
  requestBudget: RequestBudget;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Test-only override for the loopback fake service. */
  baseUrl?: string;
}

const MAX_RESPONSE_BYTES = 3_500_000;
const MAX_RETRIES = 3;

type V2Method = 'GET' | 'POST' | 'PATCH';

export class AroFloV2Client {
  private readonly config: AppConfig;
  private readonly token: string;
  private readonly requestBudget: RequestBudget;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly baseUrl: string;

  constructor(options: AroFloV2ClientOptions) {
    if (options.config.v2ApiToken === undefined) {
      throw new ConnectorError('CONFIGURATION', 'AroFlo v2 API token is not configured');
    }

    this.config = options.config;
    this.token = options.config.v2ApiToken;
    this.requestBudget = options.requestBudget;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.baseUrl = (options.baseUrl ?? 'https://api.aroflo.com/v2').replace(/\/+$/, '');
  }

  healthcheck(): Promise<unknown> {
    return this.request('GET', '/healthcheck');
  }

  listInvoices(query: InvoiceListQuery): Promise<unknown> {
    return this.request('GET', '/invoices', encodeV2Query(query));
  }

  getInvoice(invoiceId: string, fields?: readonly string[]): Promise<unknown> {
    const query = fields === undefined ? {} : { fields };
    return this.request('GET', `/invoices/${encodeURIComponent(invoiceId)}`, encodeV2Query(query));
  }

  getDefaultRecipients(invoiceId: string): Promise<unknown> {
    return this.request('GET', `/invoices/${encodeURIComponent(invoiceId)}/defaultrecipients`);
  }

  createInvoice(input: CreateInvoiceInput): Promise<unknown> {
    return this.request('POST', '/invoices', undefined, input);
  }

  listInvoiceLineItems(invoiceId: string, query: InvoiceLineListQuery): Promise<unknown> {
    return this.request('GET', `/invoices/${encodeURIComponent(invoiceId)}/lineitems`, encodeV2Query(query));
  }

  updateInvoiceLineItem(
    invoiceId: string,
    invoiceLineItemId: string,
    fields: InvoiceLinePatch
  ): Promise<unknown> {
    const { id: _ignoredId, ...patch } = fields;
    return this.request(
      'PATCH',
      `/invoices/${encodeURIComponent(invoiceId)}/lineitems/${encodeURIComponent(invoiceLineItemId)}`,
      undefined,
      { lineItems: [{ id: invoiceLineItemId, ...patch }] }
    );
  }

  private async request(
    method: V2Method,
    path: string,
    query?: URLSearchParams,
    body?: unknown
  ): Promise<unknown> {
    const encodedQuery = query?.toString() ?? '';
    const url = `${this.baseUrl}${path}${encodedQuery === '' ? '' : `?${encodedQuery}`}`;
    let lastError: ConnectorError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await this.requestBudget.acquire();
        return await this.requestOnce(method, url, body);
      } catch (caught) {
        const normalized = this.normalizeThrown(caught);
        const error = method === 'GET' || !normalized.retryable
          ? normalized
          : new ConnectorError(normalized.code, normalized.message, false);
        lastError = error;

        if (method !== 'GET' || !error.retryable || attempt === MAX_RETRIES) throw error;
        const retryAfter = caught instanceof V2HttpError ? caught.retryAfterMs : undefined;
        const backoff = 250 * (2 ** attempt) + Math.floor(this.random() * 100);
        await this.sleep(retryAfter ?? backoff);
      }
    }

    throw lastError ?? new ConnectorError('UPSTREAM', 'AroFlo v2 request failed', true);
  }

  private async requestOnce(method: V2Method, url: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json'
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const init: RequestInit = {
      method,
      headers,
      redirect: 'error',
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    };

    try {
      const response = await this.fetchImpl(url, init);
      if (response.status === 204) return null;
      const responseBody = await this.readJson(response, !response.ok);
      if (!response.ok) throw this.httpError(response, responseBody);
      return redact(responseBody, this.sensitiveValues());
    } catch (caught) {
      if (controller.signal.aborted) {
        throw new ConnectorError('TIMEOUT', 'AroFlo v2 request timed out', true);
      }
      throw caught;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJson(response: Response, allowMalformed: boolean): Promise<unknown> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
      response.body?.cancel().catch(() => undefined);
      throw new ConnectorError('RESPONSE_TOO_LARGE', 'AroFlo v2 response exceeded 3.5 MB');
    }

    const reader = response.body?.getReader();
    let raw = '';

    if (reader !== undefined) {
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ConnectorError('RESPONSE_TOO_LARGE', 'AroFlo v2 response exceeded 3.5 MB');
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      } catch (caught) {
        await reader.cancel().catch(() => undefined);
        throw caught;
      }
    } else {
      raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new ConnectorError('RESPONSE_TOO_LARGE', 'AroFlo v2 response exceeded 3.5 MB');
      }
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      if (allowMalformed) return undefined;
      throw new ConnectorError('MALFORMED_RESPONSE', 'AroFlo v2 returned malformed JSON');
    }
  }

  private httpError(response: Response, body: unknown): V2HttpError {
    const status = response.status;
    const code: ConnectorErrorCode = status === 401
      ? 'AUTHENTICATION'
      : status === 403
        ? 'PERMISSION'
        : status === 408
          ? 'TIMEOUT'
          : status === 429
            ? 'RATE_LIMIT'
            : status >= 500
              ? 'UPSTREAM'
              : 'VALIDATION';
    const retryable = status === 408 || status === 429 || status >= 500;
    return new V2HttpError(code, this.safeHttpMessage(status, body), retryable, this.retryAfterMs(response));
  }

  private safeHttpMessage(status: number, body: unknown): string {
    const record = body !== null && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const detail = [record.message, record.error, record.statusMessage]
      .find((value): value is string | number => typeof value === 'string' || typeof value === 'number');
    const rawMessage = detail === undefined
      ? `AroFlo v2 HTTP ${status}`
      : `AroFlo v2 HTTP ${status}: ${String(detail)}`;
    return String(redact(rawMessage, this.sensitiveValues())).slice(0, 500);
  }

  private sensitiveValues(): readonly string[] {
    return [
      this.token,
      this.config.credentials.uEncoded,
      this.config.credentials.pEncoded,
      this.config.credentials.orgEncoded,
      this.config.credentials.secretKey,
      this.config.credentials.hostIp ?? ''
    ];
  }

  private retryAfterMs(response: Response): number | undefined {
    const value = response.headers.get('retry-after');
    if (value === null) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.max(0, Number(value) * 1_000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - this.now().getTime());
  }

  private normalizeThrown(caught: unknown): ConnectorError {
    if (caught instanceof ConnectorError) return caught;
    return new ConnectorError('UPSTREAM', 'AroFlo v2 network request failed', true);
  }
}

class V2HttpError extends ConnectorError {
  constructor(
    code: ConnectorErrorCode,
    message: string,
    retryable: boolean,
    readonly retryAfterMs?: number
  ) {
    super(code, message, retryable);
  }
}
