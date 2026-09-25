import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AroFloClient, AroFloPage } from '../../src/aroflo/client.js';
import type { AppConfig } from '../../src/config.js';
import { buildMcpServer } from '../../src/mcp/build-server.js';
import { createConnectorServer, registerReadTools } from '../../src/mcp/sdk-adapter.js';
import { READ_TOOL_NAMES } from '../../src/tools/read-tools.js';

const config: AppConfig = {
  credentials: { uEncoded: 'fake-user', pEncoded: 'fake-password', orgEncoded: 'fake-org', secretKey: 'fake-secret' },
  transport: 'stdio',
  writeEnabled: false,
  writableAreas: new Set(),
  financialWritesEnabled: false,
  bindHost: '127.0.0.1',
  allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
  port: 3000,
  requestTimeoutMs: 100
};
const rateBudget = { secondRemaining: 2, minuteRemaining: 99, dailyUsed: 7, dailySoftLimit: 1_900 };
const page = (records: readonly unknown[]): AroFloPage => ({
  records, page: 1, hasMore: false, statusMessage: 'OK', rateBudget
});

function fakeClient() {
  return {
    search: vi.fn(async () => page([{ taskid: 'T-1', taskname: 'Inspect', orgname: 'Example Org' }])),
    get: vi.fn(async () => ({ taskid: 'T-1', taskname: 'Inspect' })),
    listChanges: vi.fn(async () => page([{ taskid: 'T-2', taskname: 'Changed' }])),
    post: vi.fn()
  };
}

const clients: Client[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connectedClient(arofloClient: ReturnType<typeof fakeClient>, identity?: { name: string; version: string }): Promise<Client> {
  const server = buildMcpServer({ config, client: arofloClient as unknown as AroFloClient, ...identity });
  const client = new Client({ name: 'connector-test', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('MCP read tools', () => {
  it('lists exactly six unconditional read-only tools and calls each over MCP', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T01:02:03.000Z'));
    const client = await connectedClient(fakeClient());

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    expect(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);

    const calls = [
      ['aroflo_connection_status', {}],
      ['aroflo_describe_area', { area: 'tasks' }],
      ['aroflo_search_records', { area: 'tasks', pageSize: 1 }],
      ['aroflo_get_record', { area: 'tasks', id: 'T-1' }],
      ['aroflo_list_changes', { area: 'tasks', sinceUtc: '2026-09-10T00:00:00.000Z' }],
      ['aroflo_preview_change', { area: 'tasks', operation: 'update', id: 'T-1', fields: { taskname: 'New name' } }]
    ] as const;

    for (const [name, arguments_] of calls) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({ type: 'text' });
      expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
      expect(result.structuredContent).toEqual(expect.any(Object));
      expect(() => JSON.stringify(result.structuredContent)).not.toThrow();
    }
  });

  it('returns sanitized isError results for handler failures', async () => {
    const arofloClient = fakeClient();
    arofloClient.get.mockRejectedValueOnce(
      new Error('upstream failed with fake-secret and Authentication: fake-user at C:\\private\\client.ts')
    );
    const client = await connectedClient(arofloClient);

    const result = await client.callTool({
      name: 'aroflo_get_record',
      arguments: { area: 'tasks', id: 'T-1' }
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.structuredContent).toMatchObject({ error: { code: 'INTERNAL' } });
    expect(serialized).not.toContain('fake-secret');
    expect(serialized).not.toContain('fake-user');
    expect(serialized).not.toMatch(/private|client\.ts|stack/i);
  });

  it('publishes supplied bounded server identity through the SDK client', async () => {
    const client = await connectedClient(fakeClient(), { name: 'aroflo-safe-test', version: '2.4.6' });

    expect(client.getServerVersion()).toEqual({ name: 'aroflo-safe-test', version: '2.4.6' });
  });

  it('publishes the connector manifest version by default', async () => {
    const client = await connectedClient(fakeClient());

    expect(client.getServerVersion()).toEqual({ name: 'aroflo-connector', version: '0.2.0' });
  });

  it('rejects empty or oversized server identity parts', () => {
    expect(() => buildMcpServer({ config, client: fakeClient() as unknown as AroFloClient, name: '  ' })).toThrow('name');
    expect(() => buildMcpServer({ config, client: fakeClient() as unknown as AroFloClient, version: 'v'.repeat(101) })).toThrow('version');
  });

  it('exports a registration helper that registers the same six tools', async () => {
    const server = createConnectorServer();
    registerReadTools(server, { config, client: fakeClient() as unknown as AroFloClient });
    const client = new Client({ name: 'connector-test', version: '1.0.0' });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);
  });
});
