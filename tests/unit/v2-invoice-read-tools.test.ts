import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AroFloClient } from '../../src/aroflo/client.js';
import type { AroFloV2Client } from '../../src/aroflo-v2/client.js';
import type { AppConfig } from '../../src/config.js';
import type { ToolDependencies } from '../../src/tools/dependencies.js';
import {
  V2_INVOICE_READ_TOOL_NAMES,
  createV2InvoiceReadToolDefinitions,
  type V2InvoiceReadToolDefinition
} from '../../src/tools/v2-invoice-read-tools.js';

const config: AppConfig = {
  credentials: {
    uEncoded: 'fake-user',
    pEncoded: 'fake-password',
    orgEncoded: 'fake-org',
    secretKey: 'fake-secret',
    hostIp: '192.0.2.10'
  },
  transport: 'stdio',
  writeEnabled: false,
  writableAreas: new Set(),
  financialWritesEnabled: false,
  v2ApiToken: 'fake-v2-token',
  mcpAccessToken: 'fake-mcp-token',
  bindHost: '127.0.0.1',
  allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
  port: 3000,
  requestTimeoutMs: 100
};

function fakeLegacyClient(): AroFloClient {
  return {} as AroFloClient;
}

function fakeV2Client() {
  return {
    healthcheck: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    listInvoices: vi.fn(async (): Promise<unknown> => ({ count: 1, items: [{ id: 'inv-1' }], page: 2 })),
    getInvoice: vi.fn(async (): Promise<unknown> => ({ id: 'inv-1', status: 'Approved' })),
    getDefaultRecipients: vi.fn(async (): Promise<unknown> => ({ to: ['billing@example.test'], cc: [], bcc: [] })),
    listInvoiceLineItems: vi.fn(async (): Promise<unknown> => ({ count: 1, items: [{ id: 'line-1' }], page: 1 }))
  };
}

function definition(
  definitions: readonly V2InvoiceReadToolDefinition[],
  name: (typeof V2_INVOICE_READ_TOOL_NAMES)[number]
): V2InvoiceReadToolDefinition {
  const found = definitions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing test tool ${name}`);
  return found;
}

describe('AroFlo v2 invoice read tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T01:02:03.000Z'));
  });

  it('omits every v2 read definition when no v2 client is configured', () => {
    const dependencies: ToolDependencies = { config, client: fakeLegacyClient() };
    expect(createV2InvoiceReadToolDefinitions(dependencies)).toEqual([]);
  });

  it('exposes the five read-only, non-destructive, idempotent definitions in stable order', () => {
    const v2Client = fakeV2Client();
    const tools = createV2InvoiceReadToolDefinitions({
      config,
      client: fakeLegacyClient(),
      v2Client: v2Client as unknown as AroFloV2Client
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'aroflo_v2_connection_status',
      'aroflo_v2_list_invoices',
      'aroflo_v2_get_invoice',
      'aroflo_v2_get_invoice_default_recipients',
      'aroflo_v2_list_invoice_line_items'
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(V2_INVOICE_READ_TOOL_NAMES);
    expect(tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations.destructiveHint === false)).toBe(true);
    expect(tools.every((tool) => tool.annotations.idempotentHint === true)).toBe(true);
  });

  it('routes each valid input to exactly one matching client method and preserves upstream envelopes', async () => {
    const v2Client = fakeV2Client();
    const tools = createV2InvoiceReadToolDefinitions({
      config,
      client: fakeLegacyClient(),
      v2Client: v2Client as unknown as AroFloV2Client
    });

    const status = await definition(tools, 'aroflo_v2_connection_status').execute({});
    const list = await definition(tools, 'aroflo_v2_list_invoices').execute({
      businessUnitId: 'bu-1', allStatus: 1, page: 2, limit: 30, fields: ['id', 'client[id,name]']
    });
    const invoice = await definition(tools, 'aroflo_v2_get_invoice').execute({
      invoiceId: 'inv-1', fields: ['id', 'status']
    });
    const recipients = await definition(tools, 'aroflo_v2_get_invoice_default_recipients').execute({ invoiceId: 'inv-1' });
    const lines = await definition(tools, 'aroflo_v2_list_invoice_line_items').execute({
      invoiceId: 'inv-1', page: 1, limit: 30, fields: ['id']
    });

    expect(status.structuredContent).toEqual({
      success: true,
      apiVersion: 'v2',
      checkedAt: '2026-09-24T01:02:03.000Z'
    });
    expect(list.structuredContent).toEqual({ count: 1, items: [{ id: 'inv-1' }], page: 2 });
    expect(invoice.structuredContent).toEqual({ id: 'inv-1', status: 'Approved' });
    expect(recipients.structuredContent).toEqual({ to: ['billing@example.test'], cc: [], bcc: [] });
    expect(lines.structuredContent).toEqual({ count: 1, items: [{ id: 'line-1' }], page: 1 });
    expect(v2Client.healthcheck).toHaveBeenCalledOnce();
    expect(v2Client.listInvoices).toHaveBeenCalledWith({
      businessUnitId: 'bu-1', allStatus: 1, page: 2, limit: 30, fields: ['id', 'client[id,name]']
    });
    expect(v2Client.getInvoice).toHaveBeenCalledWith('inv-1', ['id', 'status']);
    expect(v2Client.getDefaultRecipients).toHaveBeenCalledWith('inv-1');
    expect(v2Client.listInvoiceLineItems).toHaveBeenCalledWith('inv-1', {
      page: 1, limit: 30, fields: ['id']
    });
    expect(Object.values(v2Client).every((method) => method.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    ['aroflo_v2_connection_status', { rawUrl: 'https://example.test' }],
    ['aroflo_v2_list_invoices', { businessUnitId: 'bu-1' }],
    ['aroflo_v2_list_invoices', { businessUnitId: 'bu-1', allStatus: 1, query: 'status=0&token=secret' }],
    ['aroflo_v2_get_invoice', { invoiceId: 'inv-1', headers: { 'x-injected': 'value' } }],
    ['aroflo_v2_get_invoice_default_recipients', { invoiceId: 'inv-1', body: {} }],
    ['aroflo_v2_list_invoice_line_items', { invoiceId: 'inv-1', limit: 101 }]
  ] as const)('rejects invalid input for %s without a client call', async (name, input) => {
    const v2Client = fakeV2Client();
    const tools = createV2InvoiceReadToolDefinitions({
      config,
      client: fakeLegacyClient(),
      v2Client: v2Client as unknown as AroFloV2Client
    });

    const result = await definition(tools, name).execute(input);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION', message: 'Invalid tool input.', retryable: false } }
    });
    expect(Object.values(v2Client).every((method) => method.mock.calls.length === 0)).toBe(true);
  });

  it('redacts every configured secret from a successful upstream response', async () => {
    const v2Client = fakeV2Client();
    v2Client.listInvoices.mockResolvedValueOnce({
      count: 1,
      items: [{
        note: 'fake-v2-token fake-user fake-password fake-org fake-secret 192.0.2.10 fake-mcp-token'
      }],
      page: 1
    });
    const tools = createV2InvoiceReadToolDefinitions({
      config,
      client: fakeLegacyClient(),
      v2Client: v2Client as unknown as AroFloV2Client
    });

    const result = await definition(tools, 'aroflo_v2_list_invoices').execute({
      businessUnitId: 'bu-1', allStatus: 1
    });
    const serialized = JSON.stringify(result);

    for (const secret of [
      'fake-v2-token', 'fake-user', 'fake-password', 'fake-org', 'fake-secret', '192.0.2.10', 'fake-mcp-token'
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
  });
});
