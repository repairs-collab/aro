import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { AroFloV2Client } from '../aroflo-v2/client.js';
import type { InvoiceLineListQuery, InvoiceListQuery } from '../aroflo-v2/contracts.js';
import type { ToolDependencies } from './dependencies.js';
import { asToolError, asToolResult, invalidInputResult, type ConnectorToolResult } from './result.js';
import {
  invoiceGetSchema,
  invoiceLineListSchema,
  invoiceListSchema,
  invoiceRecipientsSchema,
  v2ConnectionStatusSchema,
  type InvoiceGetInput,
  type InvoiceLineListInput,
  type InvoiceListInput,
  type InvoiceRecipientsInput
} from './v2-invoice-schemas.js';

export const V2_INVOICE_READ_TOOL_NAMES = [
  'aroflo_v2_connection_status',
  'aroflo_v2_list_invoices',
  'aroflo_v2_get_invoice',
  'aroflo_v2_get_invoice_default_recipients',
  'aroflo_v2_list_invoice_line_items'
] as const;

export interface V2InvoiceReadToolDefinition {
  name: (typeof V2_INVOICE_READ_TOOL_NAMES)[number];
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  execute(input: unknown): Promise<ConnectorToolResult>;
}

const READ_ONLY_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
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

function definition<T>(
  dependencies: ToolDependencies,
  client: AroFloV2Client,
  name: V2InvoiceReadToolDefinition['name'],
  title: string,
  description: string,
  inputSchema: z.ZodType<T>,
  handler: (client: AroFloV2Client, input: T) => Promise<unknown>
): V2InvoiceReadToolDefinition {
  const sensitiveValues = configuredSecrets(dependencies);
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    async execute(input: unknown): Promise<ConnectorToolResult> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return invalidInputResult();
      try {
        return asToolResult(await handler(client, parsed.data), sensitiveValues);
      } catch (error) {
        return asToolError(error, sensitiveValues);
      }
    }
  };
}

export function createV2InvoiceReadToolDefinitions(
  dependencies: ToolDependencies
): readonly V2InvoiceReadToolDefinition[] {
  const client = dependencies.v2Client;
  if (client === undefined) return [];

  return [
    definition(
      dependencies,
      client,
      'aroflo_v2_connection_status',
      'AroFlo v2 connection status',
      'Verify the configured AroFlo API v2 token with one health-check request.',
      v2ConnectionStatusSchema,
      async (v2Client) => {
        await v2Client.healthcheck();
        return { success: true, apiVersion: 'v2', checkedAt: new Date().toISOString() };
      }
    ),
    definition(
      dependencies,
      client,
      'aroflo_v2_list_invoices',
      'List AroFlo v2 invoices',
      'List invoices using only documented, bounded API v2 query parameters.',
      invoiceListSchema,
      (v2Client, input: InvoiceListInput) => v2Client.listInvoices(input as InvoiceListQuery)
    ),
    definition(
      dependencies,
      client,
      'aroflo_v2_get_invoice',
      'Get AroFlo v2 invoice',
      'Get one invoice by its bounded identifier with an optional field projection.',
      invoiceGetSchema,
      (v2Client, input: InvoiceGetInput) => v2Client.getInvoice(input.invoiceId, input.fields)
    ),
    definition(
      dependencies,
      client,
      'aroflo_v2_get_invoice_default_recipients',
      'Get AroFlo v2 invoice default recipients',
      'Resolve the default recipients for one invoice.',
      invoiceRecipientsSchema,
      (v2Client, input: InvoiceRecipientsInput) => v2Client.getDefaultRecipients(input.invoiceId)
    ),
    definition(
      dependencies,
      client,
      'aroflo_v2_list_invoice_line_items',
      'List AroFlo v2 invoice line items',
      'List bounded pages of line items for one invoice.',
      invoiceLineListSchema,
      (v2Client, input: InvoiceLineListInput) => {
        const { invoiceId, ...query } = input;
        return v2Client.listInvoiceLineItems(invoiceId, query as InvoiceLineListQuery);
      }
    )
  ];
}
