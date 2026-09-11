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
});
