import { afterEach, describe, expect, it, vi } from 'vitest';
import { AroFloClient } from '../../src/aroflo/client.js';
import { ConnectorError } from '../../src/aroflo/errors.js';
import type { RequestBudget } from '../../src/aroflo/rate-limiter.js';
import { AroFloV2Client } from '../../src/aroflo-v2/client.js';
import { encodeV2Query, type InvoiceListQuery } from '../../src/aroflo-v2/contracts.js';
import type { AppConfig } from '../../src/config.js';
import { startFakeAroFloServer, type FakeAroFloServer } from './fake-aroflo-server.js';

const config: AppConfig = {
  credentials: {
    uEncoded: 'fake-user',
    pEncoded: 'fake-key',
    orgEncoded: 'fake-org',
    secretKey: 'fake-secret'
  },
  transport: 'stdio',
  writeEnabled: false,
  writableAreas: new Set(),
  financialWritesEnabled: false,
  v2ApiToken: 'fake-v2-token',
  bindHost: '127.0.0.1',
  allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
  port: 3000,
  requestTimeoutMs: 1_000
};

const servers: FakeAroFloServer[] = [];

async function fakeServer(): Promise<FakeAroFloServer> {
  const server = await startFakeAroFloServer();
  servers.push(server);
  return server;
}

function fakeBudget(): RequestBudget {
  return {
    acquire: vi.fn(async () => undefined),
    getDailyUsed: vi.fn(() => 0),
    getDailyLimit: vi.fn(() => 1_900)
  };
}

function v2Client(
  server: FakeAroFloServer,
  options: Partial<ConstructorParameters<typeof AroFloV2Client>[0]> = {}
): AroFloV2Client {
  return new AroFloV2Client({
    config,
    requestBudget: fakeBudget(),
    baseUrl: `${server.baseUrl}v2`,
    ...options
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('AroFloV2Client wire contract', () => {
  it('sends bearer-authenticated GETs to the documented paths with safe query encoding', async () => {
    const server = await fakeServer();
    server.queue(
      { body: { ok: 'health' } },
      { body: { items: [] } },
      { body: { id: 'invoice' } },
      { body: { to: [], cc: [], bcc: [] } },
      { body: { items: [] } }
    );
    const redirects: RequestRedirect[] = [];
    const realFetch = fetch;
    const client = v2Client(server, {
      fetchImpl: async (input, init) => {
        redirects.push(init?.redirect ?? 'follow');
        return realFetch(input, init);
      }
    });

    await client.healthcheck();
    await client.listInvoices({
      businessUnitId: 'bu/one',
      allStatus: 1,
      paymentStatus: 0,
      sortBy: 'invoiceNo',
      orderBy: 'desc',
      page: 2,
      limit: 30,
      fields: ['id', 'client[id,name]']
    });
    await client.getInvoice('inv/?% ü', ['id', 'status']);
    await client.getDefaultRecipients('inv-1');
    await client.listInvoiceLineItems('inv-1', { page: 1, limit: 30, fields: ['id', 'description'] });

    expect(server.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
    expect(server.requests.map((request) => request.url)).toEqual([
      '/v2/healthcheck',
      '/v2/invoices?businessUnitId=bu%2Fone&allStatus=1&paymentStatus=0&sortBy=invoiceNo&orderBy=desc&page=2&limit=30&_fields=id%2Cclient%5Bid%2Cname%5D',
      '/v2/invoices/inv%2F%3F%25%20%C3%BC?_fields=id%2Cstatus',
      '/v2/invoices/inv-1/defaultrecipients',
      '/v2/invoices/inv-1/lineitems?page=1&limit=30&_fields=id%2Cdescription'
    ]);
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe('Bearer fake-v2-token');
      expect(request.headers.accept).toBe('application/json');
      expect(request.headers['content-type']).toBeUndefined();
    }
    expect(redirects).toEqual(['error', 'error', 'error', 'error', 'error']);

    const listUrl = new URL(server.requests[1]?.url ?? '', server.baseUrl);
    for (const name of ['businessUnitId', 'allStatus', 'paymentStatus', 'sortBy', 'orderBy', 'page', 'limit', '_fields']) {
      expect(listUrl.searchParams.getAll(name), name).toHaveLength(1);
    }
  });

  it('encodes only supported query properties', () => {
    const query = {
      businessUnitId: 'bu-1',
      zoneName: 'TASKS',
      page: 2,
      fields: ['id'],
      unsupported: 'must-not-leak'
    } as InvoiceListQuery & { unsupported: string };

    const params = encodeV2Query(query);
    expect(Object.fromEntries(params)).toEqual({
      zoneName: 'TASKS',
      businessUnitId: 'bu-1',
      page: '2',
      _fields: 'id'
    });
    expect(params.has('unsupported')).toBe(false);
  });

  it('sends documented JSON bodies for invoice creation and line-item updates', async () => {
    const server = await fakeServer();
    server.queue({ body: { id: 'inv-1' } }, { body: { id: 'line-1' } });
    const client = v2Client(server);

    await client.createInvoice({
      businessUnitId: 'bu-1',
      taskId: 'task-1',
      type: 'FINAL_INVOICE',
      defaultLayout: 'DETAILED',
      taxInclusive: true
    });
    await client.updateInvoiceLineItem('inv-1', 'line-1', {
      id: 'body-id-must-not-win',
      description: 'Service labour',
      quantity: 2,
      sell: 125
    });

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v2/invoices',
      body: JSON.stringify({
        businessUnitId: 'bu-1',
        taskId: 'task-1',
        type: 'FINAL_INVOICE',
        defaultLayout: 'DETAILED',
        taxInclusive: true
      })
    });
    expect(server.requests[1]).toMatchObject({
      method: 'PATCH',
      url: '/v2/invoices/inv-1/lineitems/line-1',
      body: JSON.stringify({
        lineItems: [{ id: 'line-1', description: 'Service labour', quantity: 2, sell: 125 }]
      })
    });
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe('Bearer fake-v2-token');
      expect(request.headers.accept).toBe('application/json');
      expect(request.headers['content-type']).toBe('application/json');
    }
  });
});

describe('AroFloV2Client resilience', () => {
  it('retries a GET no more than three times and honors Retry-After', async () => {
    const server = await fakeServer();
    server.queue(...Array.from({ length: 4 }, () => ({
      status: 429,
      headers: { 'retry-after': '2' },
      body: { message: 'Wait' }
    })));
    const delays: number[] = [];
    const client = v2Client(server, {
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0
    });

    await expect(client.healthcheck()).rejects.toMatchObject({ code: 'RATE_LIMIT', retryable: true });
    expect(server.requests).toHaveLength(4);
    expect(delays).toEqual([2_000, 2_000, 2_000]);
  });

  it.each([
    ['POST', 429],
    ['POST', 500],
    ['PATCH', 429],
    ['PATCH', 500]
  ] as const)('%s makes one request after HTTP %i and reports it as non-retryable', async (method, status) => {
    const server = await fakeServer();
    server.queue({ status, body: { message: 'Temporary failure' } });
    const client = v2Client(server, { sleep: async () => undefined });

    const request = method === 'POST'
      ? client.createInvoice({ businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE' })
      : client.updateInvoiceLineItem('inv-1', 'line-1', { description: 'Labour' });

    await expect(request).rejects.toMatchObject({ retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  it('returns a successful null value for HTTP 204 without parsing JSON', async () => {
    const server = await fakeServer();
    server.queue({ status: 204, rawBody: '{not-json' });

    await expect(v2Client(server).healthcheck()).resolves.toBeNull();
  });

  it.each([
    [400, 'VALIDATION', false, 1],
    [404, 'VALIDATION', false, 1],
    [409, 'VALIDATION', false, 1],
    [422, 'VALIDATION', false, 1],
    [401, 'AUTHENTICATION', false, 1],
    [403, 'PERMISSION', false, 1],
    [408, 'TIMEOUT', true, 4],
    [429, 'RATE_LIMIT', true, 4],
    [500, 'UPSTREAM', true, 4],
    [503, 'UPSTREAM', true, 4]
  ] as const)('maps HTTP %i to %s', async (status, code, retryable, attempts) => {
    const server = await fakeServer();
    server.queue(...Array.from({ length: attempts }, () => ({ status, body: { message: 'Safe failure' } })));
    const client = v2Client(server, { sleep: async () => undefined, random: () => 0 });

    await expect(client.healthcheck()).rejects.toMatchObject({ code, retryable });
    expect(server.requests).toHaveLength(attempts);
  });

  it('maps malformed success JSON to MALFORMED_RESPONSE', async () => {
    const server = await fakeServer();
    server.queue({ rawBody: '{broken' });

    await expect(v2Client(server).healthcheck()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      retryable: false
    });
  });

  it('rejects declared and streamed bodies over 3.5 MB', async () => {
    const server = await fakeServer();
    server.queue(
      { headers: { 'content-length': '3500001' }, rawBody: 'x' },
      { chunks: ['{"padding":"', 'x'.repeat(3_500_000), '"}'] }
    );
    const client = v2Client(server);

    await expect(client.healthcheck()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    await expect(client.healthcheck()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(server.requests).toHaveLength(2);
  });

  it('redacts the bearer token from upstream response details', async () => {
    const server = await fakeServer();
    server.queue({ status: 400, body: { message: 'Denied fake-v2-token' } });

    const error = await v2Client(server).healthcheck().catch((caught: unknown) => caught) as ConnectorError;

    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toContain('Denied');
    expect(error.message).not.toContain('fake-v2-token');
  });

  it('redacts the bearer token from successful response data', async () => {
    const server = await fakeServer();
    server.queue({
      body: { nested: { authorization: ['Bearer', 'fake-v2-token'].join(' '), note: 'fake-v2-token' } }
    });

    await expect(v2Client(server).healthcheck()).resolves.toEqual({
      nested: { authorization: '[REDACTED]', note: '[REDACTED]' }
    });
  });

  it('redacts the bearer token from successful response property names', async () => {
    const server = await fakeServer();
    server.queue({ body: { nested: { 'fake-v2-token': 'echoed as a key' } } });

    const result = await v2Client(server).healthcheck();

    expect(result).toEqual({ nested: { '[REDACTED]': 'echoed as a key' } });
    expect(JSON.stringify(result)).not.toContain('fake-v2-token');
  });

  it('aborts a stalled response at requestTimeoutMs', async () => {
    const server = await fakeServer();
    server.queue(...Array.from({ length: 4 }, () => ({ chunks: ['{"partial":'], stall: true })));
    const budget = fakeBudget();
    const client = v2Client(server, {
      config: { ...config, requestTimeoutMs: 10 },
      requestBudget: budget,
      sleep: async () => undefined,
      random: () => 0
    });

    const outcome = await Promise.race([
      client.healthcheck().catch((caught: unknown) => caught),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 250))
    ]);

    expect(outcome).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(budget.acquire).toHaveBeenCalledTimes(4);
  });

  it('shares one request budget with a concurrent legacy request', async () => {
    const legacyServer = await fakeServer();
    const v2Server = await fakeServer();
    legacyServer.queue({
      body: { status: '0', statusmessage: 'OK', zoneresponse: { tasks: [] } }
    });
    v2Server.queue({ body: { ok: true } });
    const budget = fakeBudget();
    const legacy = new AroFloClient({ config, requestBudget: budget, baseUrl: legacyServer.baseUrl });
    const v2 = v2Client(v2Server, { requestBudget: budget });

    await Promise.all([legacy.search({ area: 'tasks', fresh: true }), v2.healthcheck()]);

    expect(budget.acquire).toHaveBeenCalledTimes(2);
  });
});
