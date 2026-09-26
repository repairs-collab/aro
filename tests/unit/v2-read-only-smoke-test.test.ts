import { describe, expect, it, vi } from 'vitest';
import { ConnectorError } from '../../src/aroflo/errors.js';
import { runV2ReadOnlySmoke } from '../../scripts/v2-read-only-smoke-test.js';

const baseEnv: NodeJS.ProcessEnv = {
  AROFLO_UENCODED: 'fake-user',
  AROFLO_PENCODED: 'fake-key',
  AROFLO_ORG_ENCODED: 'fake-org',
  AROFLO_SECRET_KEY: 'fake-secret'
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('AroFlo v2 read-only smoke test', () => {
  it('returns a safe configuration error before making a request when the v2 token is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const error = await runV2ReadOnlySmoke(baseEnv, { fetchImpl }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: 'CONFIGURATION', retryable: false });
    expect((error as Error).message).toBe('AroFlo v2 API token is not configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs only the healthcheck when no business-unit ID is configured', async () => {
    const token = 'generated-v2-smoke-token';
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ customer: { name: 'Private Customer' } }));

    const result = await runV2ReadOnlySmoke({ ...baseEnv, AROFLO_V2_API_TOKEN: token }, { fetchImpl });

    expect(result).toEqual({ healthcheck: 'ok' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toBe('https://api.aroflo.com/v2/healthcheck');
    expect(init?.method).toBe('GET');
    expect(JSON.stringify(result)).not.toMatch(/generated-v2-smoke-token|Private Customer/);
  });

  it('lists one invoice then reads its detail, recipients, and lines using GET only', async () => {
    const token = 'generated-v2-smoke-token';
    const invoiceId = 'invoice/one';
    const bodies = [
      { status: 'healthy' },
      { count: 1, items: [{ id: invoiceId, customer: { name: 'Private Customer' } }] },
      { id: invoiceId, customer: { name: 'Private Customer' } },
      { to: [{ email: 'private@example.test' }], cc: [], bcc: [] },
      { count: 1, items: [{ id: 'line-private', description: 'Private service' }] }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(bodies.shift()));

    const result = await runV2ReadOnlySmoke({
      ...baseEnv,
      AROFLO_V2_API_TOKEN: token,
      AROFLO_V2_SMOKE_BUSINESS_UNIT_ID: 'business unit/one'
    }, { fetchImpl });

    expect(result).toEqual({
      healthcheck: 'ok',
      invoiceList: 'ok',
      invoiceDetail: 'ok',
      defaultRecipients: 'ok',
      lineItems: 'ok'
    });
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.aroflo.com/v2/healthcheck',
      'https://api.aroflo.com/v2/invoices?businessUnitId=business+unit%2Fone&allStatus=1&page=1&limit=1',
      'https://api.aroflo.com/v2/invoices/invoice%2Fone',
      'https://api.aroflo.com/v2/invoices/invoice%2Fone/defaultrecipients',
      'https://api.aroflo.com/v2/invoices/invoice%2Fone/lineitems?page=1&limit=1'
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.body === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/generated-v2-smoke-token|Private Customer|private@example|Private service/);
  });

  it('marks dependent reads as skipped when the invoice list is empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: 'healthy' }))
      .mockResolvedValueOnce(jsonResponse({ count: 0, items: [] }));

    const result = await runV2ReadOnlySmoke({
      ...baseEnv,
      AROFLO_V2_API_TOKEN: 'fake-v2-token',
      AROFLO_V2_SMOKE_BUSINESS_UNIT_ID: 'bu-1'
    }, { fetchImpl });

    expect(result).toEqual({
      healthcheck: 'ok',
      invoiceList: 'ok',
      invoiceDetail: 'skipped-empty-list',
      defaultRecipients: 'skipped-empty-list',
      lineItems: 'skipped-empty-list'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});
