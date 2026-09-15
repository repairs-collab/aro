import { describe, expect, it } from 'vitest';
import { TimedCache } from '../../src/aroflo/cache.js';

describe('TimedCache', () => {
  it('keeps exact keys distinct and expires values after 30 seconds', () => {
    let now = 1_000;
    const cache = new TimedCache<string>(30_000, () => now);
    cache.set('GET zone=tasks&page=1', 'page-one');

    expect(cache.get('GET zone=tasks&page=1')).toBe('page-one');
    expect(cache.get('GET zone=tasks&page=2')).toBeUndefined();
    now += 29_999;
    expect(cache.get('GET zone=tasks&page=1')).toBe('page-one');
    now += 1;
    expect(cache.get('GET zone=tasks&page=1')).toBeUndefined();
  });

  it('does not let an older in-flight result overwrite a newer value', () => {
    let now = 10;
    const cache = new TimedCache<string>(30_000, () => now);
    cache.set('GET same', 'old');
    now += 1;
    cache.set('GET same', 'new');

    expect(cache.get('GET same')).toBe('new');
  });
});
