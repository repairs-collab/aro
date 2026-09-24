import type { AppConfig, Area } from '../config.js';
import { redact } from '../redaction.js';
import { compileReadQuery, getAreaDefinition } from './area-registry.js';
import type { FilterInput, SearchInput } from './areas/types.js';
import { signedHeaders } from './auth.js';
import { TimedCache } from './cache.js';
import { ConnectorError, type ConnectorErrorCode } from './errors.js';
import { encodePairs, type EncodedPair } from './query.js';
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimits, type RequestBudget } from './rate-limiter.js';

export type { FilterInput, SearchInput } from './areas/types.js';

export interface RateBudget {
  secondRemaining?: number;
  minuteRemaining?: number;
  dailyUsed: number;
  dailySoftLimit: number;
}

export interface AroFloPage<T = unknown> {
  records: readonly T[];
  page: number;
  hasMore: boolean;
  statusMessage: string;
  rateBudget: RateBudget;
}

export interface AroFloClientOptions {
  config: AppConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Test-only override for the loopback fake service. */
  baseUrl?: string;
  /** Test-only override for exercising budget boundaries quickly. */
  rateLimits?: RateLimits;
  requestBudget?: RequestBudget;
}

interface NormalizedBody {
  status?: unknown;
  statuscode?: unknown;
  statusmessage?: unknown;
  zoneresponse?: unknown;
  currentpage?: unknown;
  totalpages?: unknown;
  hasmore?: unknown;
}

const MAX_RESPONSE_BYTES = 3_500_000;
const MAX_PAGE = 10;
const MAX_RECORDS = 500;
const CACHE_TTL_MS = 30_000;
const MAX_RETRIES = 3;

function numericHeader(headers: Headers, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw !== null && /^\d+$/.test(raw.trim())) return Number(raw);
  }
  return undefined;
}

function recordsFrom(zoneResponse: unknown, area: Area): readonly unknown[] {
  if (Array.isArray(zoneResponse)) return zoneResponse;
  if (zoneResponse === null || typeof zoneResponse !== 'object') return [];
  const response = zoneResponse as Record<string, unknown>;
  const direct = response[area];
  if (Array.isArray(direct)) return direct;
  const firstArray = Object.values(response).find(Array.isArray);
  return firstArray ?? [];
}

function parsePageNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseNonNegative(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export class AroFloClient {
  private readonly config: AppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly baseUrl: string;
  private readonly cache: TimedCache<AroFloPage>;
  private readonly limiter: RequestBudget;

  constructor(options: AroFloClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.baseUrl = options.baseUrl ?? 'https://api.aroflo.com/';
    this.cache = new TimedCache(CACHE_TTL_MS, () => this.now().getTime());
    this.limiter = options.requestBudget ?? new RateLimiter({
      now: this.now,
      sleep: this.sleep,
      limits: options.rateLimits ?? { ...DEFAULT_RATE_LIMITS }
    });
  }

  async search(input: SearchInput): Promise<AroFloPage> {
    const page = input.page ?? 1;
    if (page > MAX_PAGE) throw new ConnectorError('VALIDATION', 'AroFlo page must be between 1 and 10');
    let pairs: readonly EncodedPair[];
    try {
      pairs = compileReadQuery({ ...input, pageSize: input.pageSize ?? 50 });
    } catch {
      throw new ConnectorError('VALIDATION', 'Invalid AroFlo search input');
    }
    return this.requestPage('GET', input.area, pairs, page, input.fresh === true);
  }

  async get(area: Area, id: string, joins: readonly string[] = []): Promise<unknown> {
    const definition = getAreaDefinition(area);
    const input: SearchInput = {
      area,
      filters: [{ field: definition.identifier, operator: 'eq', value: id }],
      joins,
      page: 1,
      pageSize: 1
    };
    const page = await this.search(input);
    return page.records[0];
  }

  async listChanges(area: Area, sinceUtc: string, page = 1): Promise<AroFloPage> {
    if (sinceUtc.trim() === '' || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
      throw new ConnectorError('VALIDATION', 'Invalid AroFlo changes input');
    }
    const definition = getAreaDefinition(area);
    return this.requestPage('GET', area, [
      ['zone', 'lastupdate'],
      ['where', `and|zonename|=|${definition.zone}`],
      ['where', `and|lastupdateutc|>|${sinceUtc}`],
      ['order', 'lastupdateutc|asc'],
      ['page', page],
      ['pageSize', 50]
    ], page, false);
  }

  async post(area: Area, postXml: string): Promise<unknown> {
    getAreaDefinition(area);
    const pairs: readonly EncodedPair[] = [['zone', area], ['postxml', postXml]];
    const result = await this.send('POST', area, pairs, 1, false, postXml);
    return result.records.length === 1 ? result.records[0] : result.records;
  }

  private async requestPage(
    method: 'GET',
    area: Area,
    pairs: readonly EncodedPair[],
    page: number,
    fresh: boolean
  ): Promise<AroFloPage> {
    return this.send(method, area, pairs, page, fresh);
  }

  private async send(
    method: 'GET' | 'POST',
    area: Area,
    pairs: readonly EncodedPair[],
    requestedPage: number,
    fresh: boolean,
    postXml?: string
  ): Promise<AroFloPage> {
    const encoded = encodePairs(pairs);
    const cacheKey = `${method} ${encoded}`;
    if (method === 'GET' && !fresh) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    let lastError: ConnectorError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await this.limiter.acquire();
        const page = await this.sendOnce(method, area, encoded, requestedPage, postXml);
        if (method === 'GET') this.cache.set(cacheKey, page);
        return page;
      } catch (caught) {
        const normalized = this.normalizeThrown(caught);
        const error = method === 'POST' && normalized.retryable
          ? new ConnectorError(normalized.code, normalized.message, false)
          : normalized;
        lastError = error;
        if (method !== 'GET' || !error.retryable || attempt === MAX_RETRIES) throw error;
        const retryAfter = caught instanceof HttpConnectorError ? caught.retryAfterMs : undefined;
        const backoff = 250 * (2 ** attempt) + Math.floor(this.random() * 100);
        await this.sleep(retryAfter ?? backoff);
      }
    }
    throw lastError ?? new ConnectorError('UPSTREAM', 'AroFlo request failed', true);
  }

  private async sendOnce(
    method: 'GET' | 'POST',
    area: Area,
    encoded: string,
    requestedPage: number,
    postXml?: string
  ): Promise<AroFloPage> {
    const timestamp = this.now().toISOString();
    const headers = signedHeaders(this.config.credentials, method, encoded, new Date(timestamp));
    const url = method === 'GET' ? `${this.baseUrl}?${encoded}` : this.baseUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const init: RequestInit = method === 'GET'
      ? { method, headers, signal: controller.signal }
      : {
          method,
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: encoded,
          signal: controller.signal
        };

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (caught) {
      clearTimeout(timeout);
      if (controller.signal.aborted) throw new ConnectorError('TIMEOUT', 'AroFlo request timed out', true);
      throw caught;
    }

    let body: NormalizedBody;
    try {
      body = await this.readJson(response, !response.ok);
    } catch (caught) {
      if (controller.signal.aborted) throw new ConnectorError('TIMEOUT', 'AroFlo request timed out', true);
      throw caught;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw this.httpError(response, body, postXml, encoded);
    this.assertBodySuccess(body, postXml, encoded, this.retryAfterMs(response));

    const records = recordsFrom(body.zoneresponse, area);
    if (records.length > MAX_RECORDS) {
      throw new ConnectorError('RESPONSE_TOO_LARGE', 'AroFlo returned more than 500 records');
    }
    const zoneMetadata = objectValue(body.zoneresponse);
    const page = parsePageNumber(body.currentpage ?? zoneMetadata.pagenumber, requestedPage);
    const totalPages = parsePageNumber(body.totalpages, page);
    const currentPageResults = parseNonNegative(zoneMetadata.currentpageresults);
    const maxPageResults = parseNonNegative(zoneMetadata.maxpageresults);
    const hasMore = typeof body.hasmore === 'boolean'
      ? body.hasmore
      : body.totalpages === undefined && currentPageResults !== undefined && maxPageResults !== undefined
        ? currentPageResults >= maxPageResults
        : page < totalPages;
    const secondRemaining = numericHeader(response.headers, 'x-ratelimit-second-remaining', 'x-rate-limit-second-remaining');
    const minuteRemaining = numericHeader(
      response.headers,
      'x-ratelimit-minute-remaining',
      'x-rate-limit-minute-remaining',
      'x-ratelimit-remaining'
    );
    const dailyLimit = numericHeader(response.headers, 'x-ratelimit-daily-limit');
    const dailyRemaining = numericHeader(response.headers, 'x-ratelimit-daily-remaining');
    const dailyUsed = numericHeader(response.headers, 'x-ratelimit-daily-used', 'x-rate-limit-daily-used')
      ?? (dailyLimit !== undefined && dailyRemaining !== undefined ? Math.max(0, dailyLimit - dailyRemaining) : undefined)
      ?? this.limiter.getDailyUsed();
    const rateBudget: RateBudget = {
      ...(secondRemaining === undefined ? {} : { secondRemaining }),
      ...(minuteRemaining === undefined ? {} : { minuteRemaining }),
      dailyUsed,
      dailySoftLimit: this.limiter.getDailyLimit()
    };
    return {
      records,
      page,
      hasMore,
      statusMessage: typeof body.statusmessage === 'string' ? body.statusmessage : '',
      rateBudget
    };
  }

  private async readJson(response: Response, allowMissingErrorBody = false): Promise<NormalizedBody> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
      response.body?.cancel().catch(() => undefined);
      throw new ConnectorError('RESPONSE_TOO_LARGE', 'AroFlo response exceeded 3.5 MB');
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
            throw new ConnectorError('RESPONSE_TOO_LARGE', 'AroFlo response exceeded 3.5 MB');
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
        throw new ConnectorError('RESPONSE_TOO_LARGE', 'AroFlo response exceeded 3.5 MB');
      }
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as NormalizedBody;
    } catch {
      if (allowMissingErrorBody) return {};
      throw new ConnectorError('MALFORMED_RESPONSE', 'AroFlo returned malformed JSON');
    }
  }

  private httpError(response: Response, body: NormalizedBody, postXml: string | undefined, encoded: string): ConnectorError {
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
    const message = this.safeStatusMessage(`AroFlo HTTP ${status}`, body, postXml, encoded);
    return new HttpConnectorError(code, message, retryable, this.retryAfterMs(response));
  }

  private assertBodySuccess(
    body: NormalizedBody,
    postXml: string | undefined,
    encoded: string,
    retryAfterMs: number | undefined
  ): void {
    if (body.status === undefined) {
      throw new ConnectorError('MALFORMED_RESPONSE', 'AroFlo response did not include a status field');
    }
    const status = String(body.status).trim().toUpperCase();
    if (['0', 'OK', 'SUCCESS', 'TRUE', '200'].includes(status)) return;

    const classification: readonly [ConnectorErrorCode, boolean] = ['1', '2', '-99999'].includes(status)
      ? ['AUTHENTICATION', false]
      : ['3', '4', '20', '30'].includes(status)
        ? ['PERMISSION', false]
        : ['6', '429'].includes(status)
          ? ['RATE_LIMIT', true]
          : status === '7'
            ? ['RATE_LIMIT', false]
            : status === '8'
              ? ['RESPONSE_TOO_LARGE', false]
              : status === '888888'
                ? ['TIMEOUT', true]
                : status === '5'
                  ? ['VALIDATION', false]
                  : ['UPSTREAM', false];
    throw new HttpConnectorError(
      classification[0],
      this.safeStatusMessage('AroFlo body error', body, postXml, encoded),
      classification[1],
      retryAfterMs
    );
  }

  private safeStatusMessage(prefix: string, body: NormalizedBody, postXml: string | undefined, encoded: string): string {
    const details = [body.statuscode, body.statusmessage]
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .map(String)
      .join(': ');
    const sensitive = [
      this.config.credentials.uEncoded,
      this.config.credentials.pEncoded,
      this.config.credentials.orgEncoded,
      this.config.credentials.secretKey,
      this.config.credentials.hostIp ?? '',
      postXml ?? '',
      encoded
    ];
    const redacted = String(redact(details === '' ? prefix : `${prefix}: ${details}`, sensitive));
    return redacted
      .replace(/\b(?:Authentication|Authorization|afdatetimeutc|HostIP)\s*[:=]\s*(?:HMAC\s+)?\S+/gi, '[REDACTED]')
      .replace(/\b(?:uencoded|pencoded|orgEncoded|postxml|secretKey)\s*=\s*\S+/gi, '[REDACTED]')
      .replace(/\braw\s*=\s*(?:\{[^}]*\}|\[[^\]]*\]|\S+)/gi, '[REDACTED]')
      .replace(/<[^>]+>[\s\S]*<\/[^>]+>/g, '[REDACTED]')
      .slice(0, 500);
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
    return new ConnectorError('UPSTREAM', 'AroFlo network request failed', true);
  }
}

class HttpConnectorError extends ConnectorError {
  constructor(
    code: ConnectorErrorCode,
    message: string,
    retryable: boolean,
    readonly retryAfterMs?: number
  ) {
    super(code, message, retryable);
  }
}
