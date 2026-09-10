import { RateBudgetExceededError } from './errors.js';

export interface RateLimits {
  second: number;
  minute: number;
  daily: number;
}

export interface RateLimiterOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  limits?: RateLimits;
}

export const DEFAULT_RATE_LIMITS: Readonly<RateLimits> = Object.freeze({
  second: 1,
  minute: 60,
  daily: 1_900
});

export const DOCUMENTED_RATE_LIMIT_CEILINGS: Readonly<RateLimits> = Object.freeze({
  second: 3,
  minute: 120,
  daily: 2_000
});

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeLimit = (value: number, fallback: number, ceiling: number): number =>
  Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), ceiling)) : fallback;
const sydneyDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export class RateLimiter {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limits: RateLimits;
  private readonly secondTimestamps: number[] = [];
  private readonly minuteTimestamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  private logicalNowMs = Number.NEGATIVE_INFINITY;
  private dailyDate = '';
  private dailyCount = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? sleepFor;
    const configured = options.limits ?? DEFAULT_RATE_LIMITS;
    this.limits = {
      second: normalizeLimit(configured.second, DEFAULT_RATE_LIMITS.second, DOCUMENTED_RATE_LIMIT_CEILINGS.second),
      minute: normalizeLimit(configured.minute, DEFAULT_RATE_LIMITS.minute, DOCUMENTED_RATE_LIMIT_CEILINGS.minute),
      daily: normalizeLimit(configured.daily, DEFAULT_RATE_LIMITS.daily, DOCUMENTED_RATE_LIMIT_CEILINGS.daily)
    };
  }

  acquire(): Promise<void> {
    const permit = this.queue.then(() => this.acquirePermit());
    this.queue = permit.catch(() => undefined);
    return permit;
  }

  getDailyUsed(): number {
    this.resetDailyBudget(this.currentTime());
    return this.dailyCount;
  }

  getDailyLimit(): number {
    return this.limits.daily;
  }

  private currentTime(): number {
    const observed = this.now().getTime();
    this.logicalNowMs = Math.max(this.logicalNowMs, observed);
    return this.logicalNowMs;
  }

  private resetDailyBudget(nowMs: number): void {
    const date = sydneyDate.format(new Date(nowMs));
    if (date !== this.dailyDate) {
      this.dailyDate = date;
      this.dailyCount = 0;
    }
  }

  private discardExpired(nowMs: number): void {
    while (this.secondTimestamps[0] !== undefined && this.secondTimestamps[0] <= nowMs - 1_000) {
      this.secondTimestamps.shift();
    }
    while (this.minuteTimestamps[0] !== undefined && this.minuteTimestamps[0] <= nowMs - 60_000) {
      this.minuteTimestamps.shift();
    }
  }

  private requiredWait(nowMs: number): number {
    const secondWait = this.secondTimestamps.length >= this.limits.second
      ? (this.secondTimestamps[0] ?? nowMs) + 1_000 - nowMs
      : 0;
    const minuteWait = this.minuteTimestamps.length >= this.limits.minute
      ? (this.minuteTimestamps[0] ?? nowMs) + 60_000 - nowMs
      : 0;
    return Math.max(secondWait, minuteWait, 0);
  }

  private async acquirePermit(): Promise<void> {
    let nowMs = this.currentTime();
    this.resetDailyBudget(nowMs);
    if (this.dailyCount >= this.limits.daily) throw new RateBudgetExceededError();

    this.discardExpired(nowMs);
    const waitMs = this.requiredWait(nowMs);
    if (waitMs > 0) {
      await this.sleep(waitMs);
      this.logicalNowMs = Math.max(this.logicalNowMs + waitMs, this.now().getTime());
      nowMs = this.currentTime();
      this.resetDailyBudget(nowMs);
      if (this.dailyCount >= this.limits.daily) throw new RateBudgetExceededError();
      this.discardExpired(nowMs);
    }

    this.secondTimestamps.push(nowMs);
    this.minuteTimestamps.push(nowMs);
    this.dailyCount += 1;
  }
}
