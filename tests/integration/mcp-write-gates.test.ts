import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AroFloClient } from '../../src/aroflo/client.js';
import type { AppConfig, Area } from '../../src/config.js';
import { buildMcpServer } from '../../src/mcp/build-server.js';
import { WRITE_TOOL_NAMES } from '../../src/tools/write-tools.js';
import { startFakeAroFloServer } from './fake-aroflo-server.js';

function config(options: {
  writeEnabled?: boolean;
  writableAreas?: readonly Area[];
  financialWritesEnabled?: boolean;
} = {}): AppConfig {
  return {
    credentials: {
      uEncoded: 'fake-user',
      pEncoded: 'fake-password',
      orgEncoded: 'fake-org',
      secretKey: 'fake-secret'
    },
    transport: 'stdio',
    writeEnabled: options.writeEnabled ?? false,
    writableAreas: new Set(options.writableAreas ?? []),
    financialWritesEnabled: options.financialWritesEnabled ?? false,
    bindHost: '127.0.0.1',
    allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
    port: 3000,
    requestTimeoutMs: 100
  };
}

function fakeClient() {
  return { search: vi.fn(), get: vi.fn(), listChanges: vi.fn(), post: vi.fn() };
}

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connectedClient(appConfig: AppConfig, arofloClient: AroFloClient): Promise<Client> {
  const server = buildMcpServer({ config: appConfig, client: arofloClient });
  const client = new Client({ name: 'write-gate-test', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function areaEnum(tool: Awaited<ReturnType<Client['listTools']>>['tools'][number]): unknown {
  const properties = tool.inputSchema.properties as Record<string, { enum?: unknown }> | undefined;
  return properties?.area?.enum;
}

describe('MCP write discovery gates', () => {
  it.each([
    { name: 'general write false', writeEnabled: false, writableAreas: ['tasks', 'invoices'], financial: true, enabled: [] },
    { name: 'empty allowlist', writeEnabled: true, writableAreas: [], financial: true, enabled: [] },
    { name: 'tasks without financial write', writeEnabled: true, writableAreas: ['tasks'], financial: false, enabled: ['tasks'] },
    { name: 'invoices without financial write', writeEnabled: true, writableAreas: ['invoices'], financial: false, enabled: [] },
    { name: 'invoices with financial write', writeEnabled: true, writableAreas: ['invoices'], financial: true, enabled: ['invoices'] },
    { name: 'tasks and invoices without financial write', writeEnabled: true, writableAreas: ['tasks', 'invoices'], financial: false, enabled: ['tasks'] }
  ] as const)('enforces the exact $name gate row at discovery', async ({ writeEnabled, writableAreas, financial, enabled }) => {
    const appConfig = config({ writeEnabled, writableAreas, financialWritesEnabled: financial });
    const client = await connectedClient(appConfig, fakeClient() as unknown as AroFloClient);

    const listed = await client.listTools();
    const writes = listed.tools.filter((tool) => (WRITE_TOOL_NAMES as readonly string[]).includes(tool.name));

    expect(writes.map((tool) => tool.name)).toEqual(enabled.length === 0 ? [] : WRITE_TOOL_NAMES);
    for (const tool of writes) {
      expect(areaEnum(tool)).toEqual(enabled);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(JSON.stringify(listed.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })))).not.toMatch(
      /delete|archive|raw|query|postxml/i
    );
  });

  it('keeps registry areas without a declared mutation operation undiscoverable', async () => {
    const appConfig = config({ writeEnabled: true, writableAreas: ['locations'] });
    const client = await connectedClient(appConfig, fakeClient() as unknown as AroFloClient);

    const names = (await client.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => (WRITE_TOOL_NAMES as readonly string[]).includes(name));

    expect(names).toEqual([]);
  });

  it('uses the real compiler and client for one POST per successful create and update', async () => {
    const service = await startFakeAroFloServer();
    try {
      service.queue(
        {
          body: {
            status: 'OK',
            zoneresponse: { tasks: [{ taskid: 'task-created', message: 'Created with fake-secret', private: 'body' }] }
          }
        },
        {
          body: {
            status: 'OK',
            zoneresponse: { tasks: [{ taskid: 'task-1', statusmessage: 'Updated with fake-password', private: 'body' }] }
          }
        }
      );
      const appConfig = config({ writeEnabled: true, writableAreas: ['tasks'] });
      const arofloClient = new AroFloClient({ config: appConfig, baseUrl: service.baseUrl });
      const client = await connectedClient(appConfig, arofloClient);

      const created = await client.callTool({
        name: 'aroflo_create_record',
        arguments: {
          area: 'tasks',
          fields: {
            taskname: 'Fix & inspect',
            'tasktype.tasktypeid': 'type-1',
            'client.clientid': 'client-1',
            'org.orgid': 'org-1'
          }
        }
      });
      const updated = await client.callTool({
        name: 'aroflo_update_record',
        arguments: { area: 'tasks', id: 'task-1', fields: { status: 'Pending' } }
      });

      expect(service.requests).toHaveLength(2);
      expect(service.requests.map((request) => request.method)).toEqual(['POST', 'POST']);
      expect(new URLSearchParams(service.requests[0]?.body).get('postxml')).toBe(
        '<tasks><task><org><orgid>org-1</orgid></org><client><clientid>client-1</clientid></client><tasktype><tasktypeid>type-1</tasktypeid></tasktype><taskname>Fix &amp; inspect</taskname></task></tasks>'
      );
      expect(new URLSearchParams(service.requests[1]?.body).get('postxml')).toBe(
        '<tasks><task><taskid>task-1</taskid><status>Pending</status></task></tasks>'
      );
      expect(created.structuredContent).toEqual({
        operation: 'create', area: 'tasks', id: 'task-created', success: true,
        upstreamMessage: 'Created with [REDACTED]'
      });
      expect(updated.structuredContent).toEqual({
        operation: 'update', area: 'tasks', id: 'task-1', success: true,
        upstreamMessage: 'Updated with [REDACTED]'
      });
      expect(JSON.stringify([created, updated])).not.toMatch(/private|postxml|<tasks>/i);
    } finally {
      await service.close();
    }
  });

  it('does not retry a failed write POST', async () => {
    const service = await startFakeAroFloServer();
    try {
      service.queue(
        { status: 500, body: { status: 'ERROR', statusmessage: 'temporary fake-secret failure' } },
        { body: { status: 'OK', zoneresponse: { tasks: [{ taskid: 'should-not-run' }] } } }
      );
      const appConfig = config({ writeEnabled: true, writableAreas: ['tasks'] });
      const arofloClient = new AroFloClient({ config: appConfig, baseUrl: service.baseUrl });
      const client = await connectedClient(appConfig, arofloClient);

      const result = await client.callTool({
        name: 'aroflo_update_record',
        arguments: { area: 'tasks', id: 'task-1', fields: { status: 'Pending' } }
      });

      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'UPSTREAM' } } });
      expect(JSON.stringify(result)).not.toContain('fake-secret');
      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]?.method).toBe('POST');
    } finally {
      await service.close();
    }
  });
});
