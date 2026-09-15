import * as z from 'zod/v4';
import { previewChange, type ChangeInput } from '../aroflo/change-compiler.js';
import { getAreaDefinition } from '../aroflo/area-registry.js';
import { AREAS } from '../config.js';

const area = z.enum(AREAS);
const boundedName = z.string().trim().min(1).max(100);
const boundedId = z.string().trim().min(1).max(256);
const boundedValue = z.union([z.string().max(10_000), z.number().finite(), z.boolean()]);
const filter = z.strictObject({ field: boundedName, operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith']), value: boundedValue });
const order = z.strictObject({ field: boundedName, direction: z.enum(['asc', 'desc']) });

function validUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if ([year, month, day, hour, minute, second].some((part) => part === undefined || Number.isNaN(part))) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 0) - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function checkSearchSupport(value: {
  area: z.infer<typeof area>;
  filters?: readonly z.infer<typeof filter>[] | undefined;
  joins?: readonly string[] | undefined;
  order?: z.infer<typeof order> | undefined;
}, context: z.RefinementCtx): void {
  const definition = getAreaDefinition(value.area);
  for (const input of value.filters ?? []) {
    const operators = definition.filters[input.field];
    if (operators === undefined || !operators.includes(input.operator) || (typeof input.value === 'string' && input.value.includes('|'))) context.addIssue({ code: 'custom', message: 'Unsupported filter', path: ['filters'] });
  }
  for (const join of value.joins ?? []) if (!definition.joins.includes(join)) context.addIssue({ code: 'custom', message: 'Unsupported join', path: ['joins'] });
  if (value.order !== undefined && !definition.orderFields.includes(value.order.field)) context.addIssue({ code: 'custom', message: 'Unsupported order', path: ['order'] });
}

export const connectionStatusSchema = z.strictObject({});
export const describeAreaSchema = z.strictObject({ area });
export const searchRecordsSchema = z.strictObject({ area, filters: z.array(filter).max(10).optional(), joins: z.array(boundedName).max(5).optional(), order: order.optional(), page: z.number().int().min(1).max(10).optional(), pageSize: z.number().int().min(1).max(100).optional(), fresh: z.boolean().optional() }).superRefine(checkSearchSupport);
export const getRecordSchema = z.strictObject({ area, id: boundedId, joins: z.array(boundedName).max(5).optional() }).superRefine(checkSearchSupport);
export const listChangesSchema = z.strictObject({ area, sinceUtc: z.string().max(40).refine(validUtcTimestamp, 'Expected a valid UTC timestamp'), page: z.number().int().min(1).max(10).optional() });
export const previewChangeSchema = z.strictObject({ area, operation: z.enum(['create', 'update']), id: boundedId.optional(), fields: z.record(boundedName, boundedValue).refine((fields) => Object.keys(fields).length <= 50) }).superRefine((value, context) => {
  try { previewChange(value as ChangeInput); } catch { context.addIssue({ code: 'custom', message: 'Unsupported change', path: ['fields'] }); }
});
export type SearchRecordsInput = z.infer<typeof searchRecordsSchema>;
export type GetRecordInput = z.infer<typeof getRecordSchema>;
export type ListChangesInput = z.infer<typeof listChangesSchema>;
export type PreviewChangeInput = z.infer<typeof previewChangeSchema>;
