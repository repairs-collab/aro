import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { AroFloClient, AroFloPage } from '../aroflo/client.js';
import { previewChange } from '../aroflo/change-compiler.js';
import { ConnectorError } from '../aroflo/errors.js';
import { describeArea } from '../aroflo/area-registry.js';
import type { ToolDependencies } from './dependencies.js';
import { asToolError, asToolResult, invalidInputResult, type ConnectorToolResult } from './result.js';
import { connectionStatusSchema, describeAreaSchema, getRecordSchema, listChangesSchema, previewChangeSchema, searchRecordsSchema, type GetRecordInput, type ListChangesInput, type PreviewChangeInput, type SearchRecordsInput } from './schemas.js';

export const READ_TOOL_NAMES = ['aroflo_connection_status', 'aroflo_describe_area', 'aroflo_search_records', 'aroflo_get_record', 'aroflo_list_changes', 'aroflo_preview_change'] as const;
export type { ToolDependencies } from './dependencies.js';
export interface ReadToolDefinition { name: (typeof READ_TOOL_NAMES)[number]; title: string; description: string; inputSchema: z.ZodType; annotations: ToolAnnotations; execute(input: unknown): Promise<ConnectorToolResult>; }
const READ_ONLY_ANNOTATIONS: ToolAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });

function secrets(config: ToolDependencies['config']): readonly string[] { return [config.credentials.uEncoded, config.credentials.pEncoded, config.credentials.orgEncoded, config.credentials.secretKey, ...(config.credentials.hostIp === undefined ? [] : [config.credentials.hostIp]), ...(config.v2ApiToken === undefined ? [] : [config.v2ApiToken]), ...(config.mcpAccessToken === undefined ? [] : [config.mcpAccessToken])]; }
function assertPageBound(page: AroFloPage): void { if (page.records.length > 500) throw new ConnectorError('RESPONSE_TOO_LARGE', 'Too many records'); }

function definition<T>(dependencies: ToolDependencies, name: ReadToolDefinition['name'], title: string, description: string, inputSchema: z.ZodType<T>, handler: (input: T) => Promise<unknown> | unknown): ReadToolDefinition {
  const sensitiveValues = secrets(dependencies.config);
  return { name, title, description, inputSchema, annotations: READ_ONLY_ANNOTATIONS, async execute(input: unknown): Promise<ConnectorToolResult> { const parsed = inputSchema.safeParse(input); if (!parsed.success) return invalidInputResult(); try { return asToolResult(await handler(parsed.data), sensitiveValues); } catch (error) { return asToolError(error, sensitiveValues); } } };
}

export function createReadToolDefinitions(dependencies: ToolDependencies): readonly ReadToolDefinition[] {
  return [
    definition(dependencies, 'aroflo_connection_status', 'AroFlo connection status', 'Verify AroFlo credentials with one minimal read request.', connectionStatusSchema, async () => { const page = await dependencies.client.search({ area: 'tasks', page: 1, pageSize: 1, fresh: true }); assertPageBound(page); return { success: true, timestamp: new Date().toISOString(), rateBudget: page.rateBudget }; }),
    definition(dependencies, 'aroflo_describe_area', 'Describe AroFlo area', 'Describe allowlisted fields, filters, joins, ordering, and mutation capabilities without an API request.', describeAreaSchema, ({ area }) => { const described = describeArea(area); return { area: described.area, zone: described.zone, identifier: described.identifier, fields: described.fields, filters: described.filters, joins: described.joins, orderFields: described.orderFields, createAvailable: described.createFields.length > 0, updateAvailable: described.updateFields.length > 0, createFields: described.createFields, updateFields: described.updateFields }; }),
    definition(dependencies, 'aroflo_search_records', 'Search AroFlo records', 'Search an allowlisted AroFlo area with bounded structured filters.', searchRecordsSchema, async (input: SearchRecordsInput) => { const page = await dependencies.client.search({ area: input.area, ...(input.filters === undefined ? {} : { filters: input.filters }), ...(input.joins === undefined ? {} : { joins: input.joins }), ...(input.order === undefined ? {} : { order: input.order }), page: input.page ?? 1, pageSize: input.pageSize ?? 50, ...(input.fresh === undefined ? {} : { fresh: input.fresh }) }); assertPageBound(page); return { area: input.area, records: page.records, page: page.page, hasMore: page.hasMore, rateBudget: page.rateBudget }; }),
    definition(dependencies, 'aroflo_get_record', 'Get AroFlo record', 'Get one allowlisted AroFlo record by identifier.', getRecordSchema, async (input: GetRecordInput) => ({ area: input.area, record: await dependencies.client.get(input.area, input.id, input.joins ?? []) })),
    definition(dependencies, 'aroflo_list_changes', 'List AroFlo changes', 'List changed records after a valid UTC timestamp.', listChangesSchema, async (input: ListChangesInput) => { const page = await dependencies.client.listChanges(input.area, input.sinceUtc, input.page ?? 1); assertPageBound(page); return { area: input.area, records: page.records, page: page.page, hasMore: page.hasMore, rateBudget: page.rateBudget }; }),
    definition(dependencies, 'aroflo_preview_change', 'Preview AroFlo change', 'Validate and preview an allowed change locally; no request is sent.', previewChangeSchema, (input: PreviewChangeInput) => previewChange({ area: input.area, operation: input.operation, fields: input.fields, ...(input.id === undefined ? {} : { id: input.id }) }))
  ];
}
