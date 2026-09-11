import type { CallToolResult } from '@modelcontextprotocol/server';
import { ConnectorError } from '../aroflo/errors.js';
import { redact } from '../redaction.js';

const MAX_MCP_RESULT_BYTES = 1_000_000;
const MAX_OUTPUT_STRING_LENGTH = 8_192;
const TRUNCATION_MARKER = '...[truncated]';

export type ConnectorToolResult = CallToolResult & {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
};

function recordValue(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  const output = Object.create(null) as Record<string, unknown>;
  output.result = value;
  return output;
}

function conciseText(value: Record<string, unknown>): string {
  const error = value.error;
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    return typeof message === 'string' ? message : 'AroFlo tool failed.';
  }
  if (value.success === true) return typeof value.organizationLabel === 'string' ? `AroFlo connection succeeded for ${value.organizationLabel}.` : 'AroFlo connection succeeded.';
  if (typeof value.area === 'string' && Array.isArray(value.fields)) return `Described AroFlo area ${value.area}.`;
  if (typeof value.area === 'string' && Array.isArray(value.records)) {
    const count = value.records.length;
    return `Returned ${count} ${value.area} record${count === 1 ? '' : 's'}.`;
  }
  if (typeof value.area === 'string' && Object.hasOwn(value, 'record')) return value.record === null ? `No ${value.area} record was found.` : `Returned one ${value.area} record.`;
  if (typeof value.area === 'string' && typeof value.operation === 'string') return `Previewed ${value.operation} for ${value.area}; no request was sent.`;
  return 'AroFlo tool completed successfully.';
}

function jsonCompatible(value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? { result: null } : JSON.parse(serialized) as Record<string, unknown>;
}

function boundStrings(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'string') {
    return value.length <= MAX_OUTPUT_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_OUTPUT_STRING_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  }
  if (value === null || typeof value !== 'object') return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const output = new Array<unknown>(value.length);
    seen.set(value, output);
    for (let index = 0; index < value.length; index += 1) {
      if (Object.hasOwn(value, index)) output[index] = boundStrings(value[index], seen);
    }
    return output;
  }
  const output = Object.create(null) as Record<string, unknown>;
  seen.set(value, output);
  const boundedKeys = new Set<string>();
  for (const [key, item] of Object.entries(value)) {
    const boundedKey = key.length <= MAX_OUTPUT_STRING_LENGTH
      ? key
      : `${key.slice(0, MAX_OUTPUT_STRING_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
    if (boundedKeys.has(boundedKey)) throw new ConnectorError('RESPONSE_TOO_LARGE', 'MCP output key collision');
    boundedKeys.add(boundedKey);
    output[boundedKey] = boundStrings(item, seen);
  }
  return output;
}

export function asToolResult(value: unknown, sensitiveValues: readonly string[] = []): ConnectorToolResult {
  const safeValue = recordValue(boundStrings(redact(recordValue(value), sensitiveValues)));
  const result: ConnectorToolResult = { content: [{ type: 'text', text: conciseText(safeValue) }], structuredContent: jsonCompatible(safeValue) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_MCP_RESULT_BYTES) throw new ConnectorError('RESPONSE_TOO_LARGE', 'MCP result exceeded its size limit');
  return result;
}

export function asToolError(error: unknown, sensitiveValues: readonly string[] = []): ConnectorToolResult {
  const code = error instanceof ConnectorError ? error.code : 'INTERNAL';
  return { ...asToolResult({ error: { code, message: 'AroFlo tool failed.', retryable: false } }, sensitiveValues), isError: true };
}

export function invalidInputResult(): ConnectorToolResult {
  return { ...asToolResult({ error: { code: 'VALIDATION', message: 'Invalid tool input.', retryable: false } }), isError: true };
}
