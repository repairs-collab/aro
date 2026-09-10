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
});
