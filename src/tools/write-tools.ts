import type { ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { AREA_DEFINITIONS } from '../aroflo/area-registry.js';
import { compileChange, type ChangeOperation } from '../aroflo/change-compiler.js';
import { ConnectorError } from '../aroflo/errors.js';
import { AREAS, canWriteArea, type Area } from '../config.js';
import { asToolError, asToolResult, invalidInputResult, type ConnectorToolResult } from './result.js';
import type { ToolDependencies } from './read-tools.js';

export const WRITE_TOOL_NAMES = ['aroflo_create_record', 'aroflo_update_record'] as const;

export interface WriteToolDefinition {
  name: (typeof WRITE_TOOL_NAMES)[number];
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  execute(input: unknown): Promise<ConnectorToolResult>;
}

const WRITE_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});
const boundedName = z.string().trim().min(1).max(100);
const boundedId = z.string().trim().min(1).max(256);
const boundedValue = z.union([z.string().max(10_000), z.number().finite(), z.boolean()]);
const fields = z.record(boundedName, boundedValue).refine((value) => Object.keys(value).length <= 50);

type WriteInput = {
  area: Area;
  id?: string;
  fields: Readonly<Record<string, string | number | boolean>>;
};

function secrets(dependencies: ToolDependencies): readonly string[] {
  const { config } = dependencies;
  return [
    config.credentials.uEncoded,
    config.credentials.pEncoded,
    config.credentials.orgEncoded,
    config.credentials.secretKey,
    ...(config.credentials.hostIp === undefined ? [] : [config.credentials.hostIp]),
    ...(config.mcpAccessToken === undefined ? [] : [config.mcpAccessToken])
  ];
}

function registryDeclaresOperation(area: Area): boolean {
  const definition = AREA_DEFINITIONS.get(area);
  return definition !== undefined && (definition.createFields.length > 0 || definition.updateFields.length > 0);
}

function enabledWritableAreas(dependencies: ToolDependencies): readonly Area[] {
  return AREAS.filter(
    (area) => canWriteArea(dependencies.config, area) && registryDeclaresOperation(area)
  );
}

function changeSchema(enabledAreas: readonly [Area, ...Area[]], operation: ChangeOperation): z.ZodType<WriteInput> {
  const shape = operation === 'create'
    ? z.strictObject({ area: z.enum(enabledAreas), fields })
    : z.strictObject({ area: z.enum(enabledAreas), id: boundedId, fields });
  return shape.superRefine((value, context) => {
    try {
      if (operation === 'create') {
        compileChange({ area: value.area, operation, fields: value.fields });
      } else {
        const update = value as WriteInput & { id: string };
        compileChange({ area: update.area, operation, id: update.id, fields: update.fields });
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'Unsupported change', path: ['fields'] });
    }
  }) as z.ZodType<WriteInput>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function receipt(
  operation: ChangeOperation,
  area: Area,
  suppliedId: string | undefined,
  upstream: unknown
): Record<string, unknown> {
  const upstreamRecord = record(upstream);
  const identifier = AREA_DEFINITIONS.get(area)?.identifier;
  const returnedId = identifier === undefined ? undefined : upstreamRecord?.[identifier];
  const id = suppliedId ?? (typeof returnedId === 'string' || typeof returnedId === 'number' ? String(returnedId) : undefined);
  const message = upstreamRecord?.statusmessage ?? upstreamRecord?.message;
  return {
    operation,
    area,
    ...(id === undefined ? {} : { id }),
    success: true,
    ...(typeof message === 'string' ? { upstreamMessage: message } : {})
  };
}

function definition(
  dependencies: ToolDependencies,
  enabledAreas: readonly [Area, ...Area[]],
  operation: ChangeOperation,
  name: WriteToolDefinition['name'],
  title: string,
  description: string
): WriteToolDefinition {
  const inputSchema = changeSchema(enabledAreas, operation);
  const sensitiveValues = secrets(dependencies);
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: WRITE_ANNOTATIONS,
    async execute(input: unknown): Promise<ConnectorToolResult> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return invalidInputResult();
      try {
        const compiled = compileChange({
          area: parsed.data.area,
          operation,
          fields: parsed.data.fields,
          ...(parsed.data.id === undefined ? {} : { id: parsed.data.id })
        });
        if (!canWriteArea(dependencies.config, parsed.data.area)) {
          throw new ConnectorError('PERMISSION', 'AroFlo writes are disabled for this area');
        }
        const upstream = await dependencies.client.post(parsed.data.area, compiled.postXml);
        return asToolResult(receipt(operation, parsed.data.area, parsed.data.id, upstream), sensitiveValues);
      } catch (error) {
        return asToolError(error, sensitiveValues);
      }
    }
  };
}

export function createWriteToolDefinitions(dependencies: ToolDependencies): readonly WriteToolDefinition[] {
  const enabledAreas = enabledWritableAreas(dependencies);
  if (enabledAreas.length === 0) return [];
  const nonEmptyAreas = enabledAreas as [Area, ...Area[]];
  return [
    definition(
      dependencies,
      nonEmptyAreas,
      'create',
      'aroflo_create_record',
      'Create AroFlo record',
      'Create one record from bounded structured fields in an enabled AroFlo area.'
    ),
    definition(
      dependencies,
      nonEmptyAreas,
      'update',
      'aroflo_update_record',
      'Update AroFlo record',
      'Update one record by identifier from bounded structured fields in an enabled AroFlo area.'
    )
  ];
}
