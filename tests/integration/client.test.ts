import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { AroFloClient } from '../../src/aroflo/client.js';
import { ConnectorError, RateBudgetExceededError } from '../../src/aroflo/errors.js';
import { startFakeAroFloServer, type FakeAroFloServer } from './fake-aroflo-server.js';

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'));

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
  port: 3000,
  requestTimeoutMs: 100
};
const fixedNow = () => new Date('2026-09-10T00:00:00.000Z');
const servers: FakeAroFloServer[] = [];

async function fakeServer(): Promise<FakeAroFloServer> {
  const server = await startFakeAroFloServer();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('AroFloClient wire contract', () => {
  it('signs and sends the exact encoded GET bytes', async () => {
    const server = await fakeServer();
    server.queue({ body: await fixture('read-success.json') });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    const result = await client.search({ area: 'tasks' });

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: 'GET',
      url: '/?zone=tasks&page=1&pageSize=50',
      body: ''
    });
    expect(server.requests[0]?.headers).toMatchObject({
      authentication: 'HMAC ddd999915c97a5c450ec31bbfa049358b07f0e673c78d49b0b7b6f7166bb3de1b9deb7b20884eee4f80ae090bb37ddf7cbbca9fc8b6829b3090dc300d41b70e9',
      afdatetimeutc: '2026-09-10T00:00:00.000Z'
    });
    expect(result.records).toEqual([{ taskid: 'task-1', taskname: 'Fake task' }]);
  });

  it('caches successful GETs for 30 seconds and fresh bypasses the cache', async () => {
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const server = await fakeServer();
    server.queue(
      { body: await fixture('read-success.json') },
      { body: { status: 'OK', statusmessage: 'Fresh', zoneresponse: { tasks: [{ taskid: 'task-2' }] } } },
      { body: { status: 'OK', statusmessage: 'Expired', zoneresponse: { tasks: [{ taskid: 'task-3' }] } } }
    );
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: () => new Date(nowMs) });

    await client.search({ area: 'tasks' });
    await client.search({ area: 'tasks' });
    expect(server.requests).toHaveLength(1);
    const fresh = await client.search({ area: 'tasks', fresh: true });
    expect(fresh.records).toEqual([{ taskid: 'task-2' }]);
    expect(server.requests).toHaveLength(2);
    nowMs += 30_000;
    const expired = await client.search({ area: 'tasks' });
    expect(expired.records).toEqual([{ taskid: 'task-3' }]);
    expect(server.requests).toHaveLength(3);
  });

  it('builds exact single-record and lastupdate requests', async () => {
    const server = await fakeServer();
    server.queue(
      { body: { status: 'OK', statusmessage: 'One', zoneresponse: { tasks: [{ taskid: 'A&B' }] } } },
      { body: { status: 'OK', statusmessage: 'Changes', zoneresponse: { tasks: [] } } }
    );
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    await expect(client.get('tasks', 'A&B', ['notes'])).resolves.toEqual({ taskid: 'A&B' });
    await client.listChanges('tasks', '2026-09-10T01:02:03Z', 2);

    expect(server.requests.map((request) => request.url)).toEqual([
      '/?zone=tasks&where=and%7Ctaskid%7C%3D%7CA%26B&join=notes&page=1&pageSize=1',
      '/?zone=tasks&lastupdate=2026-09-10T01%3A02%3A03Z&page=2&pageSize=50'
    ]);
  });

  it.each([
    ['tasks', 'taskid'],
    ['clients', 'clientid'],
    ['locations', 'locationid'],
    ['quotes', 'quoteid'],
    ['invoices', 'invoiceid'],
    ['schedules', 'scheduleid'],
    ['users', 'userid'],
    ['assets', 'assetid'],
    ['inventory', 'itemid']
  ] as const)('gets one %s record using its canonical identifier %s', async (area, identifier) => {
    const server = await fakeServer();
    server.queue({
      body: { status: '0', statusmessage: 'Login OK', zoneresponse: { [area]: [{ [identifier]: 'fake-id' }] } }
    });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    await expect(client.get(area, 'fake-id')).resolves.toEqual({ [identifier]: 'fake-id' });
    expect(server.requests[0]?.url).toBe(
      `/?zone=${area}&where=and%7C${identifier}%7C%3D%7Cfake-id&page=1&pageSize=1`
    );
  });

  it('rejects pages above ten and responses above 500 records without sending or returning them', async () => {
    const server = await fakeServer();
    server.queue({ body: { status: 'OK', statusmessage: 'Too many', zoneresponse: { tasks: Array.from({ length: 501 }, (_, taskid) => ({ taskid })) } } });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    await expect(client.search({ area: 'tasks', page: 11 })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(server.requests).toHaveLength(0);
    await expect(client.search({ area: 'tasks', pageSize: 100, fresh: true })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(server.requests).toHaveLength(1);
  });

  it('normalizes rate headers into the returned budget', async () => {
    const server = await fakeServer();
    server.queue({
      headers: {
        'x-ratelimit-second-remaining': '0',
        'x-ratelimit-minute-remaining': '59',
        'x-ratelimit-daily-used': '42'
      },
      body: await fixture('read-success.json')
    });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    await expect(client.search({ area: 'tasks' })).resolves.toMatchObject({
      rateBudget: { secondRemaining: 0, minuteRemaining: 59, dailyUsed: 42, dailySoftLimit: 1_900 }
    });
  });

  it('accepts the official status-zero body and nested paging fields', async () => {
    const server = await fakeServer();
    server.queue({
      headers: {
        'x-ratelimit-limit': '120',
        'x-ratelimit-remaining': '108',
        'x-ratelimit-daily-limit': '2000',
        'x-ratelimit-daily-remaining': '702'
      },
      body: {
        status: '0',
        statusmessage: 'Login OK',
        zoneresponse: {
          tasks: [{ taskid: 'official-shape' }],
          maxpageresults: '50',
          pagenumber: '2',
          currentpageresults: '50'
        }
      }
    });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    await expect(client.search({ area: 'tasks', page: 2 })).resolves.toMatchObject({
      records: [{ taskid: 'official-shape' }],
      page: 2,
      hasMore: true,
      statusMessage: 'Login OK',
      rateBudget: { minuteRemaining: 108, dailyUsed: 1_298, dailySoftLimit: 1_900 }
    });
  });
});

describe('AroFloClient failures and retries', () => {
  it('turns HTTP-200 body failures into sanitized stable errors', async () => {
    const server = await fakeServer();
    server.queue({ body: await fixture('body-error.json') });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    const error = await client.search({ area: 'tasks' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: 'UPSTREAM', retryable: false });
    expect((error as Error).message).toContain('E42');
    expect((error as Error).message).toContain('Fake request was rejected');
    expect((error as Error).message).not.toContain('fake-secret');
  });

  it('removes echoed headers, signatures, credentials, XML, and raw-looking data from errors', async () => {
    const server = await fakeServer();
    server.queue({
      body: {
        status: '99',
        statusmessage: 'Rejected Authentication: HMAC aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa uencoded=foreign-user postxml=<tasks><task>very-private</task></tasks> raw={"private":"body"}',
        zoneresponse: {}
      }
    });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    const error = await client.search({ area: 'tasks' }).catch((caught: unknown) => caught) as Error;

    expect(error.message).toContain('AroFlo body error');
    expect(error.message).not.toMatch(/HMAC|uencoded|postxml|very-private|"private"/i);
  });

  it('redacts an echoed exact encoded GET payload from a body error', async () => {
    const server = await fakeServer();
    const encoded = 'zone=tasks&where=and%7Cclientname%7C%3D%7CAcme%20Private&page=1&pageSize=50';
    server.queue({
      body: {
        status: '99',
        statusmessage: `Rejected request ${encoded}`,
        zoneresponse: {}
      }
    });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    const error = await client.search({
      area: 'tasks',
      filters: [{ field: 'clientname', operator: 'eq', value: 'Acme Private' }]
    }).catch((caught: unknown) => caught) as Error;

    expect(error.message).toContain('AroFlo body error');
    expect(error.message).not.toContain(encoded);
    expect(error.message).not.toMatch(/Acme|clientname|where=|zone=tasks/i);
  });

  it('classifies and retries an HTTP-200 AroFlo rate-limit status without caching failures', async () => {
    const server = await fakeServer();
    server.queue(
      { body: { status: '429', statusmessage: 'Too Many Requests Per Second', zoneresponse: {} } },
      { body: { status: '429', statusmessage: 'Too Many Requests Per Second', zoneresponse: {} } },
      { body: { status: '429', statusmessage: 'Too Many Requests Per Second', zoneresponse: {} } },
      { body: { status: '429', statusmessage: 'Too Many Requests Per Second', zoneresponse: {} } },
      { body: await fixture('read-success.json') }
    );
    const client = new AroFloClient({
      config,
      baseUrl: server.baseUrl,
      now: fixedNow,
      sleep: async () => undefined,
      random: () => 0,
      rateLimits: { second: 10_000, minute: 10_000, daily: 1_900 }
    });

    await expect(client.search({ area: 'tasks' })).rejects.toMatchObject({ code: 'RATE_LIMIT', retryable: true });
    await expect(client.search({ area: 'tasks' })).resolves.toMatchObject({ records: [{ taskid: 'task-1' }] });
    expect(server.requests).toHaveLength(5);
  });

  it('honors Retry-After on an HTTP-200 body-level 429', async () => {
    const server = await fakeServer();
    server.queue(
      {
        headers: { 'retry-after': '2' },
        body: { status: '429', statusmessage: 'Too Many Requests Per Second', zoneresponse: {} }
      },
      { body: await fixture('read-success.json') }
    );
    const delays: number[] = [];
    const client = new AroFloClient({
      config,
      baseUrl: server.baseUrl,
      now: fixedNow,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
      rateLimits: { second: 3, minute: 120, daily: 1_900 }
    });

    await expect(client.search({ area: 'tasks', fresh: true })).resolves.toMatchObject({
      records: [{ taskid: 'task-1' }]
    });
    expect(delays).toEqual([2_000]);
    expect(server.requests).toHaveLength(2);
  });

  it('rejects malformed JSON and oversized raw responses with stable codes', async () => {
    const server = await fakeServer();
    server.queue(
      { rawBody: '{broken' },
      { headers: { 'content-length': '3500001' }, rawBody: 'x' }
    );
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    await expect(client.search({ area: 'tasks', fresh: true })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(client.search({ area: 'tasks', fresh: true })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('aborts when response headers arrive but the body stalls', async () => {
    const server = await fakeServer();
    server.queue(...Array.from({ length: 4 }, () => ({ chunks: ['{"status":"0",'], stall: true })));
    const client = new AroFloClient({
      config: { ...config, requestTimeoutMs: 10 },
      baseUrl: server.baseUrl,
      now: fixedNow,
      sleep: async () => undefined,
      random: () => 0,
      rateLimits: { second: 3, minute: 120, daily: 1_900 }
    });

    const outcome = await Promise.race([
      client.search({ area: 'tasks', fresh: true }).catch((caught: unknown) => caught),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 250))
    ]);

    expect(outcome).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(server.requests).toHaveLength(4);
  });

  it('rejects a chunked response over 3.5 MB without relying on Content-Length', async () => {
    const server = await fakeServer();
    server.queue({ chunks: ['{"padding":"', 'x'.repeat(3_500_000), '"}'] });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow });

    await expect(client.search({ area: 'tasks', fresh: true })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      retryable: false
    });
    expect(server.requests).toHaveLength(1);
  });

  it('aborts a timed-out request and returns a retryable timeout after at most four attempts', async () => {
    const server = await fakeServer();
    const responseBody = await fixture('read-success.json');
    server.queue(...Array.from({ length: 4 }, () => ({ delayMs: 100, body: responseBody })));
    const client = new AroFloClient({
      config: { ...config, requestTimeoutMs: 10 },
      baseUrl: server.baseUrl,
      now: fixedNow,
      sleep: async () => undefined,
      random: () => 0
    });

    await expect(client.search({ area: 'tasks', fresh: true })).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(server.requests).toHaveLength(4);
  });

  it.each([408, 429, 500, 503])('retries eligible GET status %i no more than three times', async (status) => {
    const server = await fakeServer();
    server.queue(
      ...Array.from({ length: 4 }, () => ({ status, body: { status: 'ERROR', statusmessage: 'Temporary fake failure' } }))
    );
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const delays: number[] = [];
    const client = new AroFloClient({
      config,
      baseUrl: server.baseUrl,
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        delays.push(ms);
        nowMs += ms;
      },
      random: () => 0,
      rateLimits: { second: 10_000, minute: 10_000, daily: 1_900 }
    });

    await expect(client.search({ area: 'tasks', fresh: true })).rejects.toBeInstanceOf(ConnectorError);
    expect(server.requests).toHaveLength(4);
    expect(delays).toHaveLength(3);
  });

  it('retries a non-JSON 5xx response without exposing its raw body', async () => {
    const server = await fakeServer();
    server.queue(...Array.from({ length: 4 }, () => ({ status: 502, rawBody: '<html>private upstream failure</html>' })));
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const client = new AroFloClient({
      config,
      baseUrl: server.baseUrl,
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      random: () => 0,
      rateLimits: { second: 3, minute: 120, daily: 1_900 }
    });

    const error = await client.search({ area: 'tasks', fresh: true }).catch((caught: unknown) => caught) as ConnectorError;

    expect(error).toMatchObject({ code: 'UPSTREAM', retryable: true });
    expect(error.message).not.toContain('private upstream failure');
    expect(server.requests).toHaveLength(4);
  });

  it('retries a network failure and honors Retry-After seconds', async () => {
    const server = await fakeServer();
    server.queue(
      { status: 429, headers: { 'retry-after': '2' }, body: { status: 'ERROR', statusmessage: 'Wait' } },
      { body: await fixture('read-success.json') }
    );
    let networkFailure = true;
    const realFetch = fetch;
    const delays: number[] = [];
    const client = new AroFloClient({
      config,
      baseUrl: server.baseUrl,
      now: fixedNow,
      fetchImpl: async (...args) => {
        if (networkFailure) {
          networkFailure = false;
          throw new TypeError('simulated network failure');
        }
        return realFetch(...args);
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
      rateLimits: { second: 10_000, minute: 10_000, daily: 1_900 }
    });

    await expect(client.search({ area: 'tasks', fresh: true })).resolves.toMatchObject({ records: [{ taskid: 'task-1' }] });
    expect(delays).toEqual([250, 2_000]);
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry non-eligible 4xx responses', async () => {
    const server = await fakeServer();
    server.queue({ status: 400, body: { status: 'ERROR', statusmessage: 'Bad fake request' } });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow, sleep: async () => undefined });

    await expect(client.search({ area: 'tasks', fresh: true })).rejects.toMatchObject({ code: 'VALIDATION', retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  it('sends POST bytes exactly once and never retries a 503', async () => {
    const server = await fakeServer();
    server.queue({ status: 503, body: { status: 'ERROR', statusmessage: 'Unavailable' } });
    const client = new AroFloClient({ config, baseUrl: server.baseUrl, now: fixedNow, sleep: async () => undefined });

    await expect(client.post('tasks', '<tasks><task>fake & value</task></tasks>')).rejects.toMatchObject({
      code: 'UPSTREAM',
      retryable: true
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: '/',
      body: 'zone=tasks&postxml=%3Ctasks%3E%3Ctask%3Efake%20%26%20value%3C%2Ftask%3E%3C%2Ftasks%3E'
    });
    expect(server.requests[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(server.requests[0]?.headers.authentication).toBe(
      'HMAC 83cced6e82e8da3ee1191d3458f6a6cfaadfd2b5cec6c0131f62749132dececf8af89cb8d54efeaff9417487ebb55459583623694f0146725878bf14c9e7eab1'
    );
  });

  it('stops before fetch when the daily budget is exhausted', async () => {
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    let fetches = 0;
    const client = new AroFloClient({
      config,
      now: () => new Date(nowMs),
      fetchImpl: async () => {
        fetches += 1;
        return new Response(JSON.stringify(await fixture('read-success.json')));
      },
      sleep: async (ms) => {
        nowMs += ms;
      },
      rateLimits: { second: 10_000, minute: 10_000, daily: 1 }
    });

    await client.search({ area: 'tasks', fresh: true });
    await expect(client.search({ area: 'tasks', fresh: true })).rejects.toBeInstanceOf(RateBudgetExceededError);
    expect(fetches).toBe(1);
  });
});
