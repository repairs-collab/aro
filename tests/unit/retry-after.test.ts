import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../../src/retry-after.js';

describe('parseRetryAfter', () => {
  const oneSecondBefore = Date.UTC(2015, 9, 21, 7, 27, 59);

  it.each([
    'Wed, 21 Oct 2015 07:28:00 GMT',
    'Wednesday, 21-Oct-15 07:28:00 GMT',
    'Wed Oct 21 07:28:00 2015'
  ])('accepts a valid HTTP-date form: %s', (value) => {
    expect(parseRetryAfter(value, oneSecondBefore)).toEqual({
      kind: 'delay',
      milliseconds: 1_000
    });
  });

  it.each([
    '2026-09-10T00:00:01Z',
    '2, 3',
    'Tue, 21 Oct 2015 07:28:00 GMT'
  ])('rejects parseable strings outside the HTTP-date grammar: %s', (value) => {
    expect(parseRetryAfter(value, oneSecondBefore)).toEqual({ kind: 'invalid' });
  });
});
