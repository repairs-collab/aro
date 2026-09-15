import { describe, expect, it } from 'vitest';
import { redact } from '../../src/redaction.js';

describe('redact', () => {
  it('redacts sensitive nested keys and header names while retaining ordinary fields', () => {
    const result = redact({
      recordId: 'JOB-42',
      status: 'Open',
      headers: { Authorization: 'Bearer private-token', 'X-Request-Id': 'request-9' },
      nested: { secretKey: 'private-key' }
    });

    expect(result).toEqual({
      recordId: 'JOB-42',
      status: 'Open',
      headers: { Authorization: '[REDACTED]', 'X-Request-Id': 'request-9' },
      nested: { secretKey: '[REDACTED]' }
    });
  });

  it('redacts signatures and access tokens inside arrays', () => {
    expect(redact([{ signature: 'signed-value' }, { accessToken: 'access-value' }, { id: '42' }])).toEqual([
      { signature: '[REDACTED]' },
      { accessToken: '[REDACTED]' },
      { id: '42' }
    ]);
  });

  it('redacts every blocked key case-insensitively', () => {
    expect(
      redact({
        Authentication: 'auth',
        AFDateTimeUTC: 'timestamp',
        HOSTIP: 'host',
        uEncoded: 'user',
        pencoded: 'password',
        orgEncoded: 'org',
        secretkey: 'secret',
        MCPAccessToken: 'token',
        postxml: '<private />',
        status: 'Open'
      })
    ).toEqual({
      Authentication: '[REDACTED]',
      AFDateTimeUTC: '[REDACTED]',
      HOSTIP: '[REDACTED]',
      uEncoded: '[REDACTED]',
      pencoded: '[REDACTED]',
      orgEncoded: '[REDACTED]',
      secretkey: '[REDACTED]',
      MCPAccessToken: '[REDACTED]',
      postxml: '[REDACTED]',
      status: 'Open'
    });
  });

  it('replaces supplied sensitive values in returned text', () => {
    expect(redact('request failed for fake-secret at /jobs', ['fake-secret'])).toBe(
      'request failed for [REDACTED] at /jobs'
    );
  });

  it('replaces supplied sensitive values recursively without treating empty strings as secrets', () => {
    expect(redact({ detail: ['fake-secret', 'prefix fake-secret suffix'], status: 'Open' }, ['', 'fake-secret'])).toEqual({
      detail: ['[REDACTED]', 'prefix [REDACTED] suffix'],
      status: 'Open'
    });
  });

  it('redacts sensitive XML values without hiding ordinary XML fields', () => {
    expect(
      redact('<Request><Authentication>private-auth</Authentication><RecordId>JOB-42</RecordId><Status>Open</Status></Request>')
    ).toBe('<Request><Authentication>[REDACTED]</Authentication><RecordId>JOB-42</RecordId><Status>Open</Status></Request>');
  });

  it('preserves JSON-parsed own __proto__ data in null-prototype output records', () => {
    const source = JSON.parse('{"nested":{"__proto__":{"token":"kept"}}}') as Record<string, unknown>;
    const result = redact(source) as Record<string, unknown>;
    const nested = result.nested as Record<string, unknown>;

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(nested.__proto__).toEqual({ token: 'kept' });
    expect(nested.token).toBeUndefined();
  });

  it('copies only own enumerable data from prototype-bearing nested inputs', () => {
    const inherited = { inherited: 'must not be copied' };
    const nested = Object.create(inherited) as Record<string, unknown>;
    nested.own = 'kept';

    const result = redact({ nested }) as { nested: Record<string, unknown> };

    expect(Object.getPrototypeOf(result.nested)).toBeNull();
    expect(result.nested).toEqual({ own: 'kept' });
    expect(Object.hasOwn(result.nested, 'inherited')).toBe(false);
  });

  it('copies only own sparse-array indexes, preserves holes, and keeps cycles', () => {
    const prototype = Object.create(Array.prototype) as unknown[];
    Object.defineProperty(prototype, '1', { value: 'inherited-secret', enumerable: true });
    const input: unknown[] = ['own', , 'fake-secret'];
    Object.setPrototypeOf(input, prototype);

    const result = redact(input, ['fake-secret', 'inherited-secret']) as unknown[];

    expect(result).toHaveLength(3);
    expect(Object.hasOwn(result, 0)).toBe(true);
    expect(Object.hasOwn(result, 1)).toBe(false);
    expect(result[1]).toBeUndefined();
    expect(result[2]).toBe('[REDACTED]');
    expect(JSON.stringify(result)).toBe('["own",null,"[REDACTED]"]');

    const cyclic: unknown[] = [];
    cyclic.length = 3;
    cyclic[2] = cyclic;
    const copiedCycle = redact(cyclic) as unknown[];
    expect(copiedCycle).toHaveLength(3);
    expect(Object.hasOwn(copiedCycle, 0)).toBe(false);
    expect(copiedCycle[2]).toBe(copiedCycle);
  });
});
