import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AroFloClient } from '../../src/aroflo/client.js';
import { RateLimiter, type RequestBudget } from '../../src/aroflo/rate-limiter.js';
import { AroFloV2Client } from '../../src/aroflo-v2/client.js';
import { V2ConfirmationStore } from '../../src/aroflo-v2/confirmation-store.js';
import type { AppConfig } from '../../src/config.js';
import { buildMcpServer } from '../../src/mcp/build-server.js';
import { createToolDependencies } from '../../src/mcp/dependencies.js';
import type { ToolDependencies } from '../../src/tools/dependencies.js';
import { READ_TOOL_NAMES } from '../../src/tools/read-tools.js';
import { V2_INVOICE_READ_TOOL_NAMES } from '../../src/tools/v2-invoice-read-tools.js';
import { V2_PREVIEW_TOOL_NAMES, V2_WRITE_TOOL_NAMES } from '../../src/tools/v2-invoice-write-tools.js';
import { WRITE_TOOL_NAMES } from '../../src/tools/write-tools.js';
import { startFakeAroFloServer, type FakeAroFloServer } from './fake-aroflo-server.js';

function config(options: { token?: boolean; writes?: boolean } = {}): AppConfig {
  return {
    credentials: {
      uEncoded: 'fake-user',
      pEncoded: 'fake-password',
      orgEncoded: 'fake-org',
      secretKey: 'fake-secret'
    },
    transport: 'stdio',
    writeEnabled: options.writes ?? false,
    writableAreas: new Set(options.writes ? ['invoices'] : []),
    financialWritesEnabled: options.writes ?? false,
    ...(options.token === true ? { v2ApiToken: 'fake-v2-token' } : {}),
    bindHost: '127.0.0.1',
    allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
    port: 3000,
    requestTimeoutMs: 1_000
  };
}

function fakeLegacyClient(): AroFloClient {
  return {} as AroFloClient;
}

function fakeV2Client(): AroFloV2Client {
  return {} as AroFloV2Client;
}

function dependencies(appConfig: AppConfig): ToolDependencies {
  if (appConfig.v2ApiToken === undefined) return { config: appConfig, client: fakeLegacyClient() };
  return {
    config: appConfig,
    client: fakeLegacyClient(),
    v2Client: fakeV2Client(),
    v2Confirmations: new V2ConfirmationStore()
  };
}

const clients: Client[] = [];
const services: FakeAroFloServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function connect(toolDependencies: ToolDependencies): Promise<Client> {
  const server = buildMcpServer(toolDependencies);
  const client = new Client({ name: 'v2-invoice-mcp-test', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function fakeBudget(): RequestBudget {
  return {
    acquire: vi.fn(async () => undefined),
    getDailyUsed: vi.fn(() => 0),
    getDailyLimit: vi.fn(() => 1_900)
  };
}

describe('MCP v2 invoice discovery', () => {
  it('keeps the exact legacy read-only surface when no v2 token exists', async () => {
    const client = await connect(dependencies(config()));

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);
  });

  it('adds five v2 reads and two previews, but no execution tools, when writes are off', async () => {
    const client = await connect(dependencies(config({ token: true })));
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      ...READ_TOOL_NAMES,
      ...V2_INVOICE_READ_TOOL_NAMES,
      ...V2_PREVIEW_TOOL_NAMES
    ]);
    expect(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);

    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of V2_INVOICE_READ_TOOL_NAMES) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      });
    }
    for (const name of V2_PREVIEW_TOOL_NAMES) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false
      });
    }
    expect(listed.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([...V2_WRITE_TOOL_NAMES]));
  });

  it('adds all nine v2 invoice tools behind all invoice write gates and exposes no unsupported operation', async () => {
    const client = await connect(dependencies(config({ token: true, writes: true })));
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toEqual([
      ...READ_TOOL_NAMES,
      ...WRITE_TOOL_NAMES,
      ...V2_INVOICE_READ_TOOL_NAMES,
      ...V2_PREVIEW_TOOL_NAMES,
      ...V2_WRITE_TOOL_NAMES
    ]);
    expect(names.filter((name) => name.startsWith('aroflo_v2_'))).toHaveLength(9);
    expect(names.join(' ')).not.toMatch(/delete|archive|send|approve|payment|add.*line|remove.*line|raw.*url|raw.*query|raw.*json/i);
    expect(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);

    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of V2_WRITE_TOOL_NAMES) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      });
    }

    expect(client.getInstructions()).toContain(
      'execute the matching write tool only with the single-use confirmationId returned by that preview'
    );
    expect(client.getInstructions()).toContain(
      'Invoice delete, archive, send, approve, payment, add-line, and remove-line operations are unsupported.'
    );
  });
});

describe('MCP v2 invoice execution', () => {
  it('uses only the documented GET, POST, and PATCH paths and never duplicates a confirmed write', async () => {
    const service = await startFakeAroFloServer();
    services.push(service);
    service.queue(
      { body: { ok: true } },
      { body: { items: [{ id: 'inv-1' }], page: { current: 1, total: 1 } } },
      { body: { id: 'inv-1', status: 1 } },
      { body: { to: ['accounts@example.test'] } },
      { body: { items: [{ id: 'line-read' }], page: { current: 1, total: 1 } } },
      { body: { id: 'inv-created' } },
      {
        body: {
          items: [{ id: 'line-1', description: 'Old description', quantity: 1 }],
          page: { current: 1, total: 1 }
        }
      },
      { body: { id: 'line-1' } }
    );
    const appConfig = config({ token: true, writes: true });
    const toolDependencies = createToolDependencies(appConfig, {
      legacyBaseUrl: service.baseUrl,
      v2BaseUrl: `${service.baseUrl}v2`,
      requestBudget: fakeBudget()
    });
    const client = await connect(toolDependencies);

    const calls = [
      ['aroflo_v2_connection_status', {}],
      ['aroflo_v2_list_invoices', { businessUnitId: 'bu-1', status: 1 }],
      ['aroflo_v2_get_invoice', { invoiceId: 'inv-1' }],
      ['aroflo_v2_get_invoice_default_recipients', { invoiceId: 'inv-1' }],
      ['aroflo_v2_list_invoice_line_items', { invoiceId: 'inv-1', page: 1, limit: 10 }]
    ] as const;
    for (const [name, arguments_] of calls) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.isError).not.toBe(true);
    }

    const createPreview = await client.callTool({
      name: 'aroflo_v2_preview_create_invoice',
      arguments: { businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE' }
    });
    const createConfirmationId = String(
      (createPreview.structuredContent as Record<string, unknown>).confirmationId
    );
    expect(service.requests).toHaveLength(5);
    await client.callTool({
      name: 'aroflo_v2_create_invoice',
      arguments: { confirmationId: createConfirmationId }
    });
    const replayedCreate = await client.callTool({
      name: 'aroflo_v2_create_invoice',
      arguments: { confirmationId: createConfirmationId }
    });
    expect(replayedCreate.isError).toBe(true);

    const linePreview = await client.callTool({
      name: 'aroflo_v2_preview_update_invoice_line_item',
      arguments: {
        invoiceId: 'inv-1',
        invoiceLineItemId: 'line-1',
        fields: { description: 'New description', quantity: 2 }
      }
    });
    const lineConfirmationId = String(
      (linePreview.structuredContent as Record<string, unknown>).confirmationId
    );
    await client.callTool({
      name: 'aroflo_v2_update_invoice_line_item',
      arguments: { confirmationId: lineConfirmationId }
    });
    const replayedLineUpdate = await client.callTool({
      name: 'aroflo_v2_update_invoice_line_item',
      arguments: { confirmationId: lineConfirmationId }
    });
    expect(replayedLineUpdate.isError).toBe(true);

    expect(service.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: '/v2/healthcheck' },
      { method: 'GET', url: '/v2/invoices?businessUnitId=bu-1&status=1' },
      { method: 'GET', url: '/v2/invoices/inv-1' },
      { method: 'GET', url: '/v2/invoices/inv-1/defaultrecipients' },
      { method: 'GET', url: '/v2/invoices/inv-1/lineitems?page=1&limit=10' },
      { method: 'POST', url: '/v2/invoices' },
      { method: 'GET', url: '/v2/invoices/inv-1/lineitems?page=1&limit=100' },
      { method: 'PATCH', url: '/v2/invoices/inv-1/lineitems/line-1' }
    ]);
    expect(service.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(service.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });
});

describe('production dependency assembly', () => {
  it('creates one RateLimiter and gives that exact RequestBudget to both clients', async () => {
    const assembled = createToolDependencies(config({ token: true }));
    const legacyBudget = (assembled.client as unknown as { limiter: RequestBudget }).limiter;
    const v2Budget = (assembled.v2Client as unknown as { requestBudget: RequestBudget }).requestBudget;

    expect(legacyBudget).toBeInstanceOf(RateLimiter);
    expect(v2Budget).toBe(legacyBudget);
  });

  it('omits both v2 dependencies when the token is absent', async () => {
    const assembled = createToolDependencies(config());

    expect(assembled).not.toHaveProperty('v2Client');
    expect(assembled).not.toHaveProperty('v2Confirmations');
  });
});
