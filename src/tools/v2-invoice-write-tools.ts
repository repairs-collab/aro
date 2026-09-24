import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { ConnectorError } from '../aroflo/errors.js';
import type { AroFloV2Client } from '../aroflo-v2/client.js';
import type { V2ConfirmationStore, V2InvoiceOperation } from '../aroflo-v2/confirmation-store.js';
import type { CreateInvoiceInput, InvoiceLinePatch } from '../aroflo-v2/contracts.js';
import { canWriteArea } from '../config.js';
import type { ToolDependencies } from './dependencies.js';
import { asToolError, asToolResult, invalidInputResult, type ConnectorToolResult } from './result.js';
import {
  createInvoiceSchema,
  executeV2WriteSchema,
  previewInvoiceLineUpdateSchema,
  type CreateInvoiceToolInput,
  type ExecuteV2WriteInput,
  type PreviewInvoiceLineUpdateInput
} from './v2-invoice-schemas.js';

export const V2_PREVIEW_TOOL_NAMES = [
  'aroflo_v2_preview_create_invoice',
  'aroflo_v2_preview_update_invoice_line_item'
] as const;

export const V2_WRITE_TOOL_NAMES = [
  'aroflo_v2_create_invoice',
  'aroflo_v2_update_invoice_line_item'
] as const;

type V2InvoiceWriteToolName =
  | (typeof V2_PREVIEW_TOOL_NAMES)[number]
  | (typeof V2_WRITE_TOOL_NAMES)[number];

export interface V2InvoiceWriteToolDefinition {
  name: V2InvoiceWriteToolName;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  execute(input: unknown): Promise<ConnectorToolResult>;
}

const PREVIEW_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
});

const WRITE_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});

function configuredSecrets(dependencies: ToolDependencies): readonly string[] {
  const { config } = dependencies;
  return [
    config.credentials.uEncoded,
    config.credentials.pEncoded,
    config.credentials.orgEncoded,
    config.credentials.secretKey,
    ...(config.credentials.hostIp === undefined ? [] : [config.credentials.hostIp]),
    ...(config.v2ApiToken === undefined ? [] : [config.v2ApiToken]),
    ...(config.mcpAccessToken === undefined ? [] : [config.mcpAccessToken])
  ];
}

function previewDefinition<T>(
  dependencies: ToolDependencies,
  name: (typeof V2_PREVIEW_TOOL_NAMES)[number],
  title: string,
  description: string,
  inputSchema: z.ZodType<T>,
  handler: (input: T, client: AroFloV2Client, store: V2ConfirmationStore) => Promise<Record<string, unknown>>
): V2InvoiceWriteToolDefinition {
  const client = dependencies.v2Client!;
  const store = dependencies.v2Confirmations!;
  const sensitiveValues = configuredSecrets(dependencies);
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: PREVIEW_ANNOTATIONS,
    async execute(input: unknown): Promise<ConnectorToolResult> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return invalidInputResult();
      try {
        const result = asToolResult(await handler(parsed.data, client, store), sensitiveValues);
        result.content = [{
          type: 'text',
          text: `Previewed ${String(result.structuredContent.operation)}; no write request was sent.\n${JSON.stringify(result.structuredContent.preview, null, 2)}`
        }];
        return result;
      } catch (error) {
        return asToolError(error, sensitiveValues);
      }
    }
  };
}

function executionDefinition(
  dependencies: ToolDependencies,
  name: (typeof V2_WRITE_TOOL_NAMES)[number],
  title: string,
  description: string,
  expectedKind: V2InvoiceOperation['kind']
): V2InvoiceWriteToolDefinition {
  const client = dependencies.v2Client!;
  const store = dependencies.v2Confirmations!;
  const sensitiveValues = configuredSecrets(dependencies);
  return {
    name,
    title,
    description,
    inputSchema: executeV2WriteSchema,
    annotations: WRITE_ANNOTATIONS,
    async execute(input: unknown): Promise<ConnectorToolResult> {
      const parsed = executeV2WriteSchema.safeParse(input);
      if (!parsed.success) return invalidInputResult();
      try {
        if (!canWriteArea(dependencies.config, 'invoices')) {
          throw new ConnectorError('PERMISSION', 'AroFlo invoice writes are disabled');
        }
        const operation = consumeConfirmation(store, parsed.data);
        if (operation.kind !== expectedKind) {
          throw new ConnectorError('VALIDATION', 'Confirmation does not match this operation');
        }
        return asToolResult(await executeOperation(client, operation), sensitiveValues);
      } catch (error) {
        return asToolError(error, sensitiveValues);
      }
    }
  };
}

function consumeConfirmation(store: V2ConfirmationStore, input: ExecuteV2WriteInput): V2InvoiceOperation {
  try {
    return store.consume(input.confirmationId);
  } catch {
    throw new ConnectorError('VALIDATION', 'Confirmation is invalid or expired');
  }
}

async function executeOperation(
  client: AroFloV2Client,
  operation: V2InvoiceOperation
): Promise<Record<string, unknown>> {
  if (operation.kind === 'createInvoice') {
    const upstream = await client.createInvoice(operation.input);
    const invoiceId = upstreamIdentifier(upstream);
    return {
      operation: operation.kind,
      ...(invoiceId === undefined ? {} : { invoiceId }),
      success: true
    };
  }

  await client.updateInvoiceLineItem(
    operation.invoiceId,
    operation.invoiceLineItemId,
    operation.fields
  );
  return { operation: operation.kind, invoiceId: operation.invoiceId, success: true };
}

function upstreamIdentifier(upstream: unknown): string | undefined {
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) return undefined;
  const record = upstream as Record<string, unknown>;
  const value = record.invoiceId ?? record.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

async function previewCreate(
  input: CreateInvoiceToolInput,
  _client: AroFloV2Client,
  store: V2ConfirmationStore
): Promise<Record<string, unknown>> {
  const { defaultLayout, ...previewFields } = input;
  const outbound = (defaultLayout === undefined || defaultLayout === 'DETAILED'
    ? previewFields
    : { ...previewFields, defaultLayout }) as CreateInvoiceInput;
  const confirmation = store.issue({ kind: 'createInvoice', input: outbound });
  return {
    operation: 'createInvoice',
    preview: {
      ...previewFields,
      effectiveLayout: defaultLayout ?? 'DETAILED'
    },
    ...confirmation
  };
}

async function previewLineUpdate(
  input: PreviewInvoiceLineUpdateInput,
  client: AroFloV2Client,
  store: V2ConfirmationStore
): Promise<Record<string, unknown>> {
  const current = await findInvoiceLine(client, input.invoiceId, input.invoiceLineItemId);
  if (current === undefined) {
    throw new ConnectorError('VALIDATION', 'Invoice line item was not found');
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input.fields)) {
    if (field === 'id' || Object.is(current[field], value)) continue;
    before[field] = current[field];
    after[field] = value;
  }

  const fields = input.fields as InvoiceLinePatch;
  const confirmation = store.issue({
    kind: 'updateInvoiceLineItem',
    invoiceId: input.invoiceId,
    invoiceLineItemId: input.invoiceLineItemId,
    fields
  });
  return {
    operation: 'updateInvoiceLineItem',
    preview: {
      invoiceId: input.invoiceId,
      invoiceLineItemId: input.invoiceLineItemId,
      before,
      after
    },
    ...confirmation
  };
}

async function findInvoiceLine(
  client: AroFloV2Client,
  invoiceId: string,
  invoiceLineItemId: string
): Promise<Record<string, unknown> | undefined> {
  for (let requestedPage = 1; requestedPage <= 10; requestedPage += 1) {
    const response = await client.listInvoiceLineItems(invoiceId, { page: requestedPage, limit: 100 });
    const envelope = asRecord(response);
    const items = Array.isArray(envelope?.items) ? envelope.items : [];
    const target = items
      .map(asRecord)
      .find((item) => item?.id === invoiceLineItemId);
    if (target !== undefined) return target;

    const page = asRecord(envelope?.page);
    const current = typeof page?.current === 'number' ? page.current : requestedPage;
    const total = typeof page?.total === 'number' ? page.total : current;
    if (current >= total) return undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function createV2InvoiceWriteToolDefinitions(
  dependencies: ToolDependencies
): readonly V2InvoiceWriteToolDefinition[] {
  if (dependencies.v2Client === undefined || dependencies.v2Confirmations === undefined) return [];

  const previews: V2InvoiceWriteToolDefinition[] = [
    previewDefinition(
      dependencies,
      'aroflo_v2_preview_create_invoice',
      'Preview AroFlo v2 invoice creation',
      'Preview a bounded invoice create request and issue a single-use confirmation without writing.',
      createInvoiceSchema,
      previewCreate
    ),
    previewDefinition(
      dependencies,
      'aroflo_v2_preview_update_invoice_line_item',
      'Preview AroFlo v2 invoice line update',
      'Verify and preview a bounded invoice line update, then issue a single-use confirmation.',
      previewInvoiceLineUpdateSchema,
      previewLineUpdate
    )
  ];

  if (!canWriteArea(dependencies.config, 'invoices')) return previews;

  return [
    ...previews,
    executionDefinition(
      dependencies,
      'aroflo_v2_create_invoice',
      'Create AroFlo v2 invoice',
      'Consume a matching single-use confirmation and create one invoice.',
      'createInvoice'
    ),
    executionDefinition(
      dependencies,
      'aroflo_v2_update_invoice_line_item',
      'Update AroFlo v2 invoice line item',
      'Consume a matching single-use confirmation and update one invoice line item.',
      'updateInvoiceLineItem'
    )
  ];
}
