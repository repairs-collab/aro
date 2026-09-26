import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AroFloClient, AroFloPage } from '../../src/aroflo/client.js';
import type { AppConfig } from '../../src/config.js';
import {
  READ_TOOL_NAMES,
  createReadToolDefinitions,
  type ReadToolDefinition
} from '../../src/tools/read-tools.js';

const config: AppConfig = {
  credentials: {
    uEncoded: 'fake-user',
    pEncoded: 'fake-password',
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
  requestTimeoutMs: 100
};

const rateBudget = { secondRemaining: 2, minuteRemaining: 99, dailyUsed: 7, dailySoftLimit: 1_900 };

function page(records: readonly unknown[]): AroFloPage {
  return { records, page: 1, hasMore: false, statusMessage: 'OK', rateBudget };
}

function fakeClient() {
  return {
    search: vi.fn(async (_input?: unknown) => page([{ taskid: 'T-1', taskname: 'Inspect', orgname: 'Example Org' }])),
    get: vi.fn(async () => ({ taskid: 'T-1', taskname: 'Inspect' })),
    listChanges: vi.fn(async () => page([{ taskid: 'T-2', taskname: 'Changed' }])),
    post: vi.fn()
  };
}

function definition(
  definitions: readonly ReadToolDefinition[],
  name: (typeof READ_TOOL_NAMES)[number]
): ReadToolDefinition {
  const found = definitions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing test tool ${name}`);
  return found;
}

function expectUsefulResult(result: Awaited<ReturnType<ReadToolDefinition['execute']>>): void {
  expect(result.isError).not.toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toMatchObject({ type: 'text' });
  expect(result.content[0]?.text.length).toBeGreaterThan(0);
  expect(() => JSON.stringify(result.structuredContent)).not.toThrow();
  expect(result.structuredContent).toEqual(expect.any(Object));
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringsIn);
}

describe('read tool definitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T01:02:03.000Z'));
  });

  it('executes each unconditional tool with useful structured output', async () => {
    const client = fakeClient();
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });
    const calls = [
      ['aroflo_connection_status', {}],
      ['aroflo_describe_area', { area: 'tasks' }],
      ['aroflo_search_records', { area: 'tasks', pageSize: 1 }],
      ['aroflo_get_record', { area: 'tasks', id: 'T-1' }],
      ['aroflo_list_changes', { area: 'tasks', sinceUtc: '2026-09-10T00:00:00.000Z' }],
      ['aroflo_preview_change', { area: 'tasks', operation: 'update', id: 'T-1', fields: { taskname: 'New name' } }]
    ] as const;

    for (const [name, input] of calls) {
      expectUsefulResult(await definition(tools, name).execute(input));
    }

    expect(tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(client.search).toHaveBeenNthCalledWith(1, { area: 'tasks', page: 1, pageSize: 1, fresh: true });
    expect(client.search.mock.calls[1]?.[0]).not.toHaveProperty('fresh');
    expect(client.get).toHaveBeenCalledOnce();
    expect(client.listChanges).toHaveBeenCalledOnce();
    expect(client.post).not.toHaveBeenCalled();
  });

  it('keeps describe and preview local and exposes only read-only annotations', async () => {
    const client = fakeClient();
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });

    const described = await definition(tools, 'aroflo_describe_area').execute({ area: 'tasks' });
    const previewed = await definition(tools, 'aroflo_preview_change').execute({
      area: 'tasks', operation: 'update', id: 'T-1', fields: { taskname: 'New name' }
    });

    expect(described.structuredContent).toMatchObject({
      area: 'tasks',
      identifier: 'taskid',
      createAvailable: true,
      updateAvailable: true,
      createFields: expect.arrayContaining(['taskname']),
      updateFields: expect.arrayContaining(['status'])
    });
    const readOnlyDescription = await definition(tools, 'aroflo_describe_area').execute({ area: 'locations' });
    expect(readOnlyDescription.structuredContent).toMatchObject({
      createAvailable: false,
      updateAvailable: false,
      createFields: [],
      updateFields: []
    });
    expect(previewed.structuredContent).toMatchObject({
      area: 'tasks', operation: 'update', id: 'T-1', changedFields: ['taskname']
    });
    expect(client.search).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
    expect(client.listChanges).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations.destructiveHint === false)).toBe(true);
  });

  it('returns only the bounded connection summary from one minimal documented GET', async () => {
    const client = fakeClient();
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });

    const result = await definition(tools, 'aroflo_connection_status').execute({});

    expect(result.structuredContent).toEqual({
      success: true,
      timestamp: '2026-09-10T01:02:03.000Z',
      rateBudget
    });
    expect(result.content[0]).toEqual({ type: 'text', text: 'AroFlo connection succeeded.' });
    expect(client.search).toHaveBeenCalledOnce();
  });

  it('does not expose untrusted task organization labels in connection status', async () => {
    const client = fakeClient();
    client.search.mockResolvedValueOnce(page([{ taskid: 'T-1', orgname: 'Hostile\u0000 task label\n' }]));
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });

    const result = await definition(tools, 'aroflo_connection_status').execute({});
    const serialized = JSON.stringify(result);

    expect(result.structuredContent).not.toHaveProperty('organizationLabel');
    expect(result.content[0]?.text).toBe('AroFlo connection succeeded.');
    expect(serialized).not.toContain('Hostile');
  });

  it.each([
    ['unknown area', 'aroflo_describe_area', { area: 'secrets' }],
    ['invalid UTC date', 'aroflo_list_changes', { area: 'tasks', sinceUtc: '2026-02-30T00:00:00Z' }],
    ['offset date', 'aroflo_list_changes', { area: 'tasks', sinceUtc: '2026-09-10T10:00:00+10:00' }],
    ['raw query string', 'aroflo_search_records', { area: 'tasks', query: 'zone=tasks&where=private' }],
    ['raw XML', 'aroflo_preview_change', { area: 'tasks', operation: 'update', id: 'T-1', postxml: '<tasks />', fields: { taskname: 'x' } }],
    ['excessive page', 'aroflo_search_records', { area: 'tasks', page: 11 }],
    ['excessive page size', 'aroflo_search_records', { area: 'tasks', pageSize: 101 }],
    ['unsupported filter', 'aroflo_search_records', { area: 'tasks', filters: [{ field: 'password', operator: 'eq', value: 'x' }] }],
    ['unsupported order', 'aroflo_search_records', { area: 'tasks', order: { field: 'password', direction: 'asc' } }],
    ['unsupported join', 'aroflo_get_record', { area: 'clients', id: 'C-1', joins: ['notes'] }],
    ['unsupported preview field', 'aroflo_preview_change', { area: 'tasks', operation: 'update', id: 'T-1', fields: { password: 'x' } }],
    ['unknown outer field', 'aroflo_get_record', { area: 'tasks', id: 'T-1', extra: true }],
    ['unknown nested field', 'aroflo_search_records', { area: 'tasks', filters: [{ field: 'status', operator: 'eq', value: 'open', extra: true }] }],
    ['excessive string', 'aroflo_get_record', { area: 'tasks', id: 'x'.repeat(257) }]
  ] as const)('rejects %s before any AroFlo client call', async (_caseName, toolName, input) => {
    const client = fakeClient();
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });

    const result = await definition(tools, toolName).execute(input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Invalid tool input.');
    expect(client.search).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
    expect(client.listChanges).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects more than 500 returned records and MCP results above one megabyte', async () => {
    const client = fakeClient();
    client.search
      .mockResolvedValueOnce(page(Array.from({ length: 501 }, (_, taskid) => ({ taskid }))))
      .mockResolvedValueOnce(page(Array.from({ length: 500 }, (_, taskid) => ({ taskid, note: 'x'.repeat(8_192) }))));
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });

    const tooMany = await definition(tools, 'aroflo_search_records').execute({ area: 'tasks' });
    const tooLarge = await definition(tools, 'aroflo_search_records').execute({ area: 'tasks', fresh: true });

    expect(tooMany).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESPONSE_TOO_LARGE' } } });
    expect(tooLarge).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESPONSE_TOO_LARGE' } } });
    expect(Buffer.byteLength(JSON.stringify(tooLarge), 'utf8')).toBeLessThanOrEqual(1_048_576);
  });

  it('redacts recursive secrets immediately before text and structured serialization', async () => {
    const client = fakeClient();
    client.get.mockRejectedValueOnce(new Error('failed with fake-secret, uEncoded=fake-user, token=fake-v2-token'));
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });

    const result = await definition(tools, 'aroflo_get_record').execute({ area: 'tasks', id: 'T-1' });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(serialized).not.toContain('fake-secret');
    expect(serialized).not.toContain('fake-user');
    expect(serialized).not.toContain('fake-v2-token');
    expect(serialized).not.toMatch(/stack|node_modules|read-tools\.ts/i);
  });

  it('bounds every hostile search, get, and change string after recursive redaction', async () => {
    const client = fakeClient();
    const hostile = `${'x'.repeat(8_165)}fake-secret${'y'.repeat(8_190)}`;
    const hostileKey = 'k'.repeat(8_300);
    client.search.mockResolvedValueOnce(page([{ taskid: 'T-1', note: hostile, [hostileKey]: 'value' }]));
    client.get.mockResolvedValueOnce({ taskid: 'T-1', note: hostile } as unknown as Awaited<ReturnType<typeof client.get>>);
    client.listChanges.mockResolvedValueOnce(page([{ taskid: 'T-1', note: hostile }]));
    const tools = createReadToolDefinitions({ config, client: client as unknown as AroFloClient });

    const results = await Promise.all([
      definition(tools, 'aroflo_search_records').execute({ area: 'tasks' }),
      definition(tools, 'aroflo_get_record').execute({ area: 'tasks', id: 'T-1' }),
      definition(tools, 'aroflo_list_changes').execute({ area: 'tasks', sinceUtc: '2026-09-10T00:00:00.000Z' })
    ]);

    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('fake-secret');
      expect(stringsIn(result.structuredContent).every((value) => value.length <= 8_192)).toBe(true);
      expect(serialized).toContain('[REDACTED]');
      expect(serialized).toContain('...[truncated]');
    }
    const searchRecords = results[0]?.structuredContent.records as Array<Record<string, unknown>>;
    expect(Object.keys(searchRecords[0] ?? {}).every((key) => key.length <= 8_192)).toBe(true);
  });
});
