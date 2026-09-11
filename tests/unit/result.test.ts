import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../src/aroflo/errors.js';
import { asToolError, asToolResult } from '../../src/tools/result.js';

describe('tool result serialization', () => {
  it('keeps own __proto__ data JSON-compatible without prototype mutation', () => {
    const parsed = JSON.parse('{"nested":{"__proto__":{"secret":"top-secret"},"value":"ordinary"}}');
    const result = asToolResult(parsed, ['top-secret']);
    const nested = (result.structuredContent.nested as Record<string, unknown>);

    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(nested.__proto__).toEqual({ secret: '[REDACTED]' });
    expect(nested.secret).toBeUndefined();
    expect(nested.value).toBe('ordinary');
    expect(() => JSON.stringify(result.structuredContent)).not.toThrow();
  });

  it('fails closed when distinct oversized keys truncate to the same output key', () => {
    const prefix = 'k'.repeat(8_178);
    const input = { [`${prefix}${'a'.repeat(15)}`]: 'first', [`${prefix}${'b'.repeat(15)}`]: 'second' };

    expect(() => asToolResult(input)).toThrow(ConnectorError);
    expect(() => asToolResult(input)).toThrow('MCP output key collision');
    expect(asToolError(new ConnectorError('RESPONSE_TOO_LARGE', 'MCP output key collision'))).toEqual(expect.objectContaining({
      isError: true,
      structuredContent: { error: expect.objectContaining({ code: 'RESPONSE_TOO_LARGE', message: 'AroFlo tool failed.' }) }
    }));
  });

  it('bounds own sparse-array values without serializing inherited numeric data', () => {
    const prototype = Object.create(Array.prototype) as unknown[];
    Object.defineProperty(prototype, '1', { value: 'inherited-secret', enumerable: true });
    const source: unknown[] = ['x'.repeat(9_000), , 'fake-secret'];
    Object.setPrototypeOf(source, prototype);

    const result = asToolResult({ records: source }, ['fake-secret', 'inherited-secret']);
    const records = result.structuredContent.records as unknown[];
    const serialized = JSON.stringify(result.structuredContent);

    expect(records).toHaveLength(3);
    expect(Object.hasOwn(records, 0)).toBe(true);
    expect(Object.hasOwn(records, 1)).toBe(true);
    expect(records[1]).toBeNull();
    expect(records[0]).toMatch(/\.\.\.\[truncated\]$/);
    expect((records[0] as string).length).toBe(8_192);
    expect(records[2]).toBe('[REDACTED]');
    expect(serialized).not.toContain('inherited-secret');
    expect(serialized).not.toContain('fake-secret');
    expect(JSON.stringify(records)).toContain('null');
  });
});
