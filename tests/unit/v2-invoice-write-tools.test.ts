import { describe, expect, it, vi } from 'vitest';
import type { AroFloClient } from '../../src/aroflo/client.js';
import { ConnectorError } from '../../src/aroflo/errors.js';
import type { AroFloV2Client } from '../../src/aroflo-v2/client.js';
import { V2ConfirmationStore } from '../../src/aroflo-v2/confirmation-store.js';
import type { AppConfig, Area } from '../../src/config.js';
import type { ToolDependencies } from '../../src/tools/dependencies.js';
import {
  V2_PREVIEW_TOOL_NAMES,
  V2_WRITE_TOOL_NAMES,
  createV2InvoiceWriteToolDefinitions,
  type V2InvoiceWriteToolDefinition
} from '../../src/tools/v2-invoice-write-tools.js';

function config(overrides: Partial<Pick<AppConfig, 'writeEnabled' | 'financialWritesEnabled'>> = {}, invoicesAllowed = true): AppConfig {
  return {
    credentials: {
      uEncoded: 'fake-user',
      pEncoded: 'fake-password',
      orgEncoded: 'fake-org',
      secretKey: 'fake-secret',
      hostIp: '192.0.2.10'
    },
    transport: 'stdio',
    writeEnabled: true,
    writableAreas: new Set<Area>(invoicesAllowed ? ['invoices'] : []),
    financialWritesEnabled: true,
    v2ApiToken: 'fake-v2-token',
    mcpAccessToken: 'fake-mcp-token',
    bindHost: '127.0.0.1',
    allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
    port: 3000,
    requestTimeoutMs: 100,
    ...overrides
  };
}

function fakeLegacyClient(): AroFloClient {
  return {} as AroFloClient;
}

function fakeV2Client() {
  return {
    createInvoice: vi.fn(async (): Promise<unknown> => ({ id: 'inv-created', private: 'raw create body' })),
    listInvoiceLineItems: vi.fn(async (
      _invoiceId: string,
      _query: { page?: number; limit?: number }
    ): Promise<unknown> => ({
      count: 1,
      items: [{ id: 'line-1', description: 'Old description', quantity: 1, sell: 100 }],
      page: { current: 1, total: 1 }
    })),
    updateInvoiceLineItem: vi.fn(async (): Promise<unknown> => ({ id: 'line-1', private: 'raw update body' }))
  };
}

function dependencies(
  runtimeConfig = config(),
  client = fakeV2Client(),
  store = new V2ConfirmationStore({ createId: () => 'confirmation-id-at-least-twenty-chars' })
): ToolDependencies {
  return {
    config: runtimeConfig,
    client: fakeLegacyClient(),
    v2Client: client as unknown as AroFloV2Client,
    v2Confirmations: store
  };
}

function definition(
  definitions: readonly V2InvoiceWriteToolDefinition[],
  name: (typeof V2_PREVIEW_TOOL_NAMES)[number] | (typeof V2_WRITE_TOOL_NAMES)[number]
): V2InvoiceWriteToolDefinition {
  const found = definitions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing test tool ${name}`);
  return found;
}

function clientCalls(client: ReturnType<typeof fakeV2Client>): number {
  return Object.values(client).reduce((total, method) => total + method.mock.calls.length, 0);
}

describe('AroFlo v2 invoice write tools', () => {
  it('previews an explicit create without a network request and preserves an omitted layout in storage', async () => {
    const client = fakeV2Client();
    const store = new V2ConfirmationStore({ createId: () => 'confirmation-id-at-least-twenty-chars' });
    const tools = createV2InvoiceWriteToolDefinitions(dependencies(config(), client, store));

    const preview = await definition(tools, 'aroflo_v2_preview_create_invoice').execute({
      businessUnitId: 'bu-1',
      taskId: 'task-1',
      type: 'FINAL_INVOICE',
      taxInclusive: true
    });

    expect(preview.structuredContent).toMatchObject({
      operation: 'createInvoice',
      preview: {
        businessUnitId: 'bu-1',
        taskId: 'task-1',
        type: 'FINAL_INVOICE',
        effectiveLayout: 'DETAILED',
        taxInclusive: true
      },
      confirmationId: 'confirmation-id-at-least-twenty-chars'
    });
    expect(preview.structuredContent).toHaveProperty('expiresAt');
    expect(preview.content[0]?.text).toContain('FINAL_INVOICE');
    expect(preview.content[0]?.text).toContain('DETAILED');
    expect(preview.content[0]?.text).toMatch(/no write request was sent/i);
    expect(clientCalls(client)).toBe(0);
    expect(store.consume('confirmation-id-at-least-twenty-chars')).toEqual({
      kind: 'createInvoice',
      input: {
        businessUnitId: 'bu-1',
        taskId: 'task-1',
        type: 'FINAL_INVOICE',
        taxInclusive: true
      }
    });
  });

  it('accepts only documented create fields and explicit invoice types', async () => {
    const client = fakeV2Client();
    const preview = definition(
      createV2InvoiceWriteToolDefinitions(dependencies(config(), client)),
      'aroflo_v2_preview_create_invoice'
    );

    for (const input of [
      { businessUnitId: 'bu-1', taskId: 'task-1' },
      { businessUnitId: 'bu-1', taskId: 'task-1', type: 'PROGRESS_INVOICE' },
      { businessUnitId: 'bu-1', taskId: 'task-1', type: 'PART_INVOICE', send: true },
      { businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE', lines: [] }
    ]) {
      const result = await preview.execute(input);
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'VALIDATION' } } });
    }
    expect(clientCalls(client)).toBe(0);
  });

  it('executes a stored create exactly once and returns no raw upstream body', async () => {
    const client = fakeV2Client();
    const tools = createV2InvoiceWriteToolDefinitions(dependencies(config(), client));
    const preview = await definition(tools, 'aroflo_v2_preview_create_invoice').execute({
      businessUnitId: 'bu-1', taskId: 'task-1', type: 'PART_INVOICE', defaultLayout: 'SIMPLE'
    });
    const confirmationId = String((preview.structuredContent as Record<string, unknown>).confirmationId);

    const result = await definition(tools, 'aroflo_v2_create_invoice').execute({ confirmationId });

    expect(client.createInvoice).toHaveBeenCalledOnce();
    expect(client.createInvoice).toHaveBeenCalledWith({
      businessUnitId: 'bu-1', taskId: 'task-1', type: 'PART_INVOICE', defaultLayout: 'SIMPLE'
    });
    expect(result.structuredContent).toEqual({ operation: 'createInvoice', invoiceId: 'inv-created', success: true });
    expect(JSON.stringify(result)).not.toMatch(/raw create body|private/i);
  });

  it('rejects invalid, expired, reused, and extra-field execution inputs without another client call', async () => {
    let nowMs = Date.parse('2026-09-24T00:00:00.000Z');
    let nextId = 0;
    const client = fakeV2Client();
    const store = new V2ConfirmationStore({
      now: () => nowMs,
      createId: () => `confirmation-id-at-least-twenty-chars-${++nextId}`
    });
    const tools = createV2InvoiceWriteToolDefinitions(dependencies(config(), client, store));
    const create = definition(tools, 'aroflo_v2_create_invoice');
    const issued = store.issue({
      kind: 'createInvoice', input: { businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE' }
    });

    expect((await create.execute({ confirmationId: 'not-valid-but-long-enough' })).structuredContent)
      .toMatchObject({ error: { code: 'VALIDATION' } });
    expect((await create.execute({ confirmationId: issued.confirmationId })).isError).not.toBe(true);
    expect((await create.execute({ confirmationId: issued.confirmationId })).structuredContent)
      .toMatchObject({ error: { code: 'VALIDATION' } });
    expect((await create.execute({ confirmationId: 'confirmation-id-at-least-twenty-chars-999', approve: true })).structuredContent)
      .toMatchObject({ error: { code: 'VALIDATION' } });

    const expired = store.issue({
      kind: 'createInvoice', input: { businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE' }
    });
    nowMs += 600_000;
    expect((await create.execute({ confirmationId: expired.confirmationId })).structuredContent)
      .toMatchObject({ error: { code: 'VALIDATION' } });
    expect(client.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('previews only changed line fields after verifying the target and executes one stored update', async () => {
    const client = fakeV2Client();
    const tools = createV2InvoiceWriteToolDefinitions(dependencies(config(), client));

    const preview = await definition(tools, 'aroflo_v2_preview_update_invoice_line_item').execute({
      invoiceId: 'inv-1',
      invoiceLineItemId: 'line-1',
      fields: { id: 'line-1', description: 'New description', quantity: 2, sell: 100 }
    });

    expect(client.listInvoiceLineItems).toHaveBeenCalledWith('inv-1', { page: 1, limit: 100 });
    expect(preview.structuredContent).toMatchObject({
      operation: 'updateInvoiceLineItem',
      preview: {
        invoiceId: 'inv-1',
        invoiceLineItemId: 'line-1',
        before: { description: 'Old description', quantity: 1 },
        after: { description: 'New description', quantity: 2 }
      }
    });
    expect((preview.structuredContent as { preview: { before: unknown; after: unknown } }).preview.before)
      .not.toHaveProperty('sell');
    expect((preview.structuredContent as { preview: { before: unknown; after: unknown } }).preview.after)
      .not.toHaveProperty('sell');

    const confirmationId = String((preview.structuredContent as Record<string, unknown>).confirmationId);
    const result = await definition(tools, 'aroflo_v2_update_invoice_line_item').execute({ confirmationId });

    expect(client.updateInvoiceLineItem).toHaveBeenCalledOnce();
    expect(client.updateInvoiceLineItem).toHaveBeenCalledWith('inv-1', 'line-1', {
      id: 'line-1', description: 'New description', quantity: 2, sell: 100
    });
    expect(result.structuredContent).toEqual({
      operation: 'updateInvoiceLineItem', invoiceId: 'inv-1', success: true
    });
  });

  it('rejects a missing target or mismatched body id without issuing a confirmation', async () => {
    let issueCalls = 0;
    const store = new V2ConfirmationStore({ createId: () => {
      issueCalls += 1;
      return 'confirmation-id-at-least-twenty-chars';
    } });
    const client = fakeV2Client();
    const preview = definition(
      createV2InvoiceWriteToolDefinitions(dependencies(config(), client, store)),
      'aroflo_v2_preview_update_invoice_line_item'
    );

    const mismatch = await preview.execute({
      invoiceId: 'inv-1', invoiceLineItemId: 'line-1', fields: { id: 'line-2', quantity: 2 }
    });
    const missing = await preview.execute({
      invoiceId: 'inv-1', invoiceLineItemId: 'line-missing', fields: { quantity: 2 }
    });

    expect(mismatch.structuredContent).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(missing.structuredContent).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(client.listInvoiceLineItems).toHaveBeenCalledOnce();
    expect(issueCalls).toBe(0);
  });

  it('follows page metadata to page two and stops as soon as the target is found', async () => {
    const client = fakeV2Client();
    client.listInvoiceLineItems
      .mockResolvedValueOnce({
        count: 2,
        items: [{ id: 'line-1', description: 'First' }],
        page: { current: 1, total: 3 }
      })
      .mockResolvedValueOnce({
        count: 2,
        items: [{ id: 'line-2', description: 'Second', quantity: 1 }],
        page: { current: 2, total: 3 }
      });
    const preview = definition(
      createV2InvoiceWriteToolDefinitions(dependencies(config(), client)),
      'aroflo_v2_preview_update_invoice_line_item'
    );

    const result = await preview.execute({
      invoiceId: 'inv-1', invoiceLineItemId: 'line-2', fields: { quantity: 3 }
    });

    expect(result.isError).not.toBe(true);
    expect(client.listInvoiceLineItems.mock.calls).toEqual([
      ['inv-1', { page: 1, limit: 100 }],
      ['inv-1', { page: 2, limit: 100 }]
    ]);
  });

  it('never fetches more than ten pages or more than 100 lines per page', async () => {
    const client = fakeV2Client();
    client.listInvoiceLineItems.mockImplementation(async (_invoiceId, query): Promise<unknown> => ({
      count: 1000,
      items: Array.from({ length: 100 }, (_, index) => ({ id: `line-${query.page ?? 1}-${index}` })),
      page: { current: query.page ?? 1, total: 99 }
    }));
    const preview = definition(
      createV2InvoiceWriteToolDefinitions(dependencies(config(), client)),
      'aroflo_v2_preview_update_invoice_line_item'
    );

    const result = await preview.execute({
      invoiceId: 'inv-1', invoiceLineItemId: 'never-found', fields: { description: 'New' }
    });

    expect(result.structuredContent).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(client.listInvoiceLineItems).toHaveBeenCalledTimes(10);
    expect(client.listInvoiceLineItems.mock.calls.every(([, query]) => query.limit === 100)).toBe(true);
  });

  it.each([
    { writeEnabled: false, invoicesAllowed: true, financial: true, executionTools: [] },
    { writeEnabled: true, invoicesAllowed: false, financial: true, executionTools: [] },
    { writeEnabled: true, invoicesAllowed: true, financial: false, executionTools: [] },
    {
      writeEnabled: true,
      invoicesAllowed: true,
      financial: true,
      executionTools: ['aroflo_v2_create_invoice', 'aroflo_v2_update_invoice_line_item']
    }
  ])('applies all financial write discovery gates: $writeEnabled/$invoicesAllowed/$financial', ({
    writeEnabled, invoicesAllowed, financial, executionTools
  }) => {
    const runtimeConfig = config({ writeEnabled, financialWritesEnabled: financial }, invoicesAllowed);
    const names = createV2InvoiceWriteToolDefinitions(dependencies(runtimeConfig)).map((tool) => tool.name);

    expect(names.filter((name) => V2_PREVIEW_TOOL_NAMES.includes(name as never))).toEqual(V2_PREVIEW_TOOL_NAMES);
    expect(names.filter((name) => V2_WRITE_TOOL_NAMES.includes(name as never))).toEqual(executionTools);
  });

  it('omits every preview and execution definition unless both v2 dependencies exist', () => {
    const complete = dependencies();
    const { v2Client: _client, ...withoutClient } = complete;
    const { v2Confirmations: _store, ...withoutStore } = complete;
    expect(createV2InvoiceWriteToolDefinitions(withoutClient)).toEqual([]);
    expect(createV2InvoiceWriteToolDefinitions(withoutStore)).toEqual([]);
  });

  it('rechecks all financial gates immediately before consuming', async () => {
    for (const disable of ['writeEnabled', 'invoicesAllowed', 'financialWritesEnabled'] as const) {
      const runtimeConfig = config();
      const client = fakeV2Client();
      const store = new V2ConfirmationStore({ createId: () => `confirmation-id-at-least-twenty-${disable}` });
      const tools = createV2InvoiceWriteToolDefinitions(dependencies(runtimeConfig, client, store));
      const issued = store.issue({
        kind: 'createInvoice', input: { businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE' }
      });

      if (disable === 'writeEnabled') runtimeConfig.writeEnabled = false;
      if (disable === 'invoicesAllowed') (runtimeConfig.writableAreas as Set<Area>).clear();
      if (disable === 'financialWritesEnabled') runtimeConfig.financialWritesEnabled = false;

      const result = await definition(tools, 'aroflo_v2_create_invoice').execute({ confirmationId: issued.confirmationId });

      expect(result.structuredContent, disable).toMatchObject({ error: { code: 'PERMISSION' } });
      expect(client.createInvoice, disable).not.toHaveBeenCalled();
      expect(store.consume(issued.confirmationId), disable).toMatchObject({ kind: 'createInvoice' });
    }
  });

  it('consumes a confirmation before a failed write so it cannot be replayed', async () => {
    const client = fakeV2Client();
    client.createInvoice.mockRejectedValueOnce(new ConnectorError('UPSTREAM', 'failed write', false));
    const tools = createV2InvoiceWriteToolDefinitions(dependencies(config(), client));
    const preview = await definition(tools, 'aroflo_v2_preview_create_invoice').execute({
      businessUnitId: 'bu-1', taskId: 'task-1', type: 'FINAL_INVOICE'
    });
    const confirmationId = String((preview.structuredContent as Record<string, unknown>).confirmationId);
    const create = definition(tools, 'aroflo_v2_create_invoice');

    expect((await create.execute({ confirmationId })).structuredContent)
      .toMatchObject({ error: { code: 'UPSTREAM' } });
    expect((await create.execute({ confirmationId })).structuredContent)
      .toMatchObject({ error: { code: 'VALIDATION' } });
    expect(client.createInvoice).toHaveBeenCalledOnce();
  });
});
