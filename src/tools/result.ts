import type { CallToolResult } from '@modelcontextprotocol/server';
import { ConnectorError } from '../aroflo/errors.js';
import { redact } from '../redaction.js';

const MAX_MCP_RESULT_BYTES = 1_000_000;

export type ConnectorToolResult = CallToolResult & {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
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

export function asToolResult(value: unknown, sensitiveValues: readonly string[] = []): ConnectorToolResult {
  const safeValue = recordValue(redact(recordValue(value), sensitiveValues));
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
