import { describe, expect, it } from 'vitest';
import { RateBudgetExceededError } from '../../src/aroflo/errors.js';
import { RateLimiter } from '../../src/aroflo/rate-limiter.js';

describe('RateLimiter', () => {
  it('enforces the conservative one-request-per-second default', async () => {
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const delays: number[] = [];
    const limiter = new RateLimiter({
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        delays.push(ms);
        nowMs += ms;
      }
    });

    await limiter.acquire();
    await limiter.acquire();

    expect(delays).toEqual([1_000]);
  });

  it('enforces sixty requests in a rolling minute', async () => {
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const delays: number[] = [];
    const limiter = new RateLimiter({
      limits: { second: 3, minute: 60, daily: 1_900 },
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        delays.push(ms);
        nowMs += ms;
      }
    });

    for (let index = 0; index < 60; index += 1) {
      await limiter.acquire();
      if (index % 3 === 2) nowMs += 1_000;
    }
    await limiter.acquire();

    expect(delays).toEqual([40_000]);
  });

  it('rejects the 1901st Sydney-local request before it can be sent and resets next day', async () => {
    let nowMs = Date.parse('2026-09-09T14:00:00.000Z');
    const limiter = new RateLimiter({
      limits: { second: 10_000, minute: 10_000, daily: 1_900 },
      now: () => new Date(nowMs),
      sleep: async () => undefined
    });
    for (let index = 0; index < 1_900; index += 1) await limiter.acquire();

    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateBudgetExceededError);
    nowMs = Date.parse('2026-09-10T14:00:00.000Z');
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('grants concurrent callers in FIFO order', async () => {
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const sleepers: Array<() => void> = [];
    const limiter = new RateLimiter({
      now: () => new Date(nowMs),
      sleep: (ms) =>
        new Promise<void>((resolve) => sleepers.push(() => {
          nowMs += ms;
          resolve();
        }))
    });
    const order: number[] = [];

    await limiter.acquire();
    const second = limiter.acquire().then(() => order.push(2));
    const third = limiter.acquire().then(() => order.push(3));
    await Promise.resolve();
    expect(sleepers).toHaveLength(1);
    sleepers.shift()?.();
    await second;
    expect(order).toEqual([2]);
    await Promise.resolve();
    sleepers.shift()?.();
    await third;
    expect(order).toEqual([2, 3]);
  });

  it('caps configured rates at the documented service ceilings', async () => {
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const delays: number[] = [];
    const limiter = new RateLimiter({
      limits: { second: 10_000, minute: 10_000, daily: 10_000 },
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        delays.push(ms);
        nowMs += ms;
      }
    });

    for (let index = 0; index < 4; index += 1) await limiter.acquire();

    expect(delays).toEqual([1_000]);
  });
});
