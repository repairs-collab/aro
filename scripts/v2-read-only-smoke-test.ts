import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AroFloV2Client } from '../src/aroflo-v2/client.js';
import { ConnectorError } from '../src/aroflo/errors.js';
import { RateLimiter } from '../src/aroflo/rate-limiter.js';
import { loadConfig } from '../src/config.js';

export interface V2SmokeSummary {
  healthcheck: 'ok';
  invoiceList?: 'ok';
  invoiceDetail?: 'ok' | 'skipped-empty-list';
  defaultRecipients?: 'ok' | 'skipped-empty-list';
  lineItems?: 'ok' | 'skipped-empty-list';
}

export async function runV2ReadOnlySmoke(
  env: NodeJS.ProcessEnv,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<V2SmokeSummary> {
  const config = loadConfig({ ...env, MCP_TRANSPORT: 'stdio' });
  const client = new AroFloV2Client({
    config,
    requestBudget: new RateLimiter(),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

  await client.healthcheck();
  const summary: V2SmokeSummary = { healthcheck: 'ok' };
  const businessUnitId = env.AROFLO_V2_SMOKE_BUSINESS_UNIT_ID?.trim();
  if (businessUnitId === undefined || businessUnitId.length === 0) return summary;

  const invoices = await client.listInvoices({ businessUnitId, allStatus: 1, page: 1, limit: 1 });
  summary.invoiceList = 'ok';
  const invoiceId = firstInvoiceId(invoices);
  if (invoiceId === undefined) {
    summary.invoiceDetail = 'skipped-empty-list';
    summary.defaultRecipients = 'skipped-empty-list';
    summary.lineItems = 'skipped-empty-list';
    return summary;
  }

  await client.getInvoice(invoiceId);
  summary.invoiceDetail = 'ok';
  await client.getDefaultRecipients(invoiceId);
  summary.defaultRecipients = 'ok';
  await client.listInvoiceLineItems(invoiceId, { page: 1, limit: 1 });
  summary.lineItems = 'ok';
  return summary;
}

function firstInvoiceId(response: unknown): string | undefined {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const items = (response as Record<string, unknown>).items;
  if (!Array.isArray(items)) return undefined;
  const first = items[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const id = (first as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isEntrypoint()) {
  try {
    const summary = await runV2ReadOnlySmoke(process.env);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const code = error instanceof ConnectorError ? error.code : 'UNEXPECTED';
    process.stderr.write(`${JSON.stringify({ status: 'error', code })}\n`);
    process.exitCode = 1;
  }
}
