import { timingSafeEqual } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cryptoMock = vi.hoisted(() => ({
  timingSafeEqual: vi.fn((left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) =>
    Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
      Buffer.from(right.buffer, right.byteOffset, right.byteLength)
    ))
}));

vi.mock('node:crypto', () => ({ timingSafeEqual: cryptoMock.timingSafeEqual }));

import { bearerMatches } from '../../src/transports/http.js';

describe('bearerMatches', () => {
  beforeEach(() => {
    cryptoMock.timingSafeEqual.mockClear();
  });

  it.each([
    ['a missing header', undefined],
    ['a wrong scheme', 'Basic dGVzdA=='],
    ['an empty bearer value', 'Bearer '],
    ['a different-length value', 'Bearer short']
  ])('rejects %s without calling timingSafeEqual', (_case, headerValue) => {
    expect(bearerMatches(headerValue, 'fake-access-token')).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it('rejects a same-length mismatch through timingSafeEqual', () => {
    expect(bearerMatches('Bearer fake-access-tokee', 'fake-access-token')).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact token through timingSafeEqual', () => {
    expect(bearerMatches('Bearer fake-access-token', 'fake-access-token')).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
