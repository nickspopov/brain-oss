// Request limits: a "token bucket" in process memory, keyed by principal (or IP) and
// class. After a restart the counters are empty; for a single process that is enough.
import type { Core } from './context.js';
import { OpError } from './errors.js';

export type RateClass = 'write' | 'read' | 'search' | 'auth_fail' | 'poll';
/** Bucket in units rather than calls: bytes returned by `read` per minute. */
export type AmountClass = 'read_bytes';

const MINUTE = 60_000;
/** Beyond this many keys, full buckets are dropped (memory does not grow from IP enumeration). */
const MAX_KEYS = 10_000;

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: (cls: RateClass | AmountClass) => number,
    private readonly now: () => number,
  ) {}

  private bucket(cls: RateClass | AmountClass, key: string): { b: Bucket; capacity: number } {
    const capacity = this.perMinute(cls);
    const id = `${cls}:${key}`;
    const now = this.now();
    let b = this.buckets.get(id);
    if (!b) {
      if (this.buckets.size >= MAX_KEYS) this.sweep();
      b = { tokens: capacity, at: now };
      this.buckets.set(id, b);
    } else {
      const elapsed = Math.max(0, now - b.at);
      b.tokens = Math.min(capacity, b.tokens + (elapsed * capacity) / MINUTE);
      b.at = now;
    }
    return { b, capacity };
  }

  /** In how many milliseconds a token appears; 0 means one is available now. */
  private waitMs(b: Bucket, capacity: number): number {
    return b.tokens >= 1 ? 0 : Math.ceil(((1 - b.tokens) * MINUTE) / capacity);
  }

  /** Take a token; empty bucket → `rate_limited` with `retry_after_ms`. */
  take(cls: RateClass, key: string): void {
    const { b, capacity } = this.bucket(cls, key);
    const wait = this.waitMs(b, capacity);
    if (wait > 0) throw new OpError('rate_limited', { retry_after_ms: wait });
    b.tokens -= 1;
  }

  /** Is the bucket empty? (does not consume a token). */
  blocked(cls: RateClass | AmountClass, key: string): number {
    const { b, capacity } = this.bucket(cls, key);
    return this.waitMs(b, capacity);
  }

  /** Consumes a token if one is available (failure accounting). */
  spend(cls: RateClass, key: string): void {
    const { b } = this.bucket(cls, key);
    b.tokens = Math.max(0, b.tokens - 1);
  }

  /**
   * Deduct `amount` units (response bytes). The bucket may go negative by at most one capacity:
   * the last large response is paid for by waiting, not by a retroactive refusal.
   */
  charge(cls: AmountClass, key: string, amount: number): void {
    const { b, capacity } = this.bucket(cls, key);
    b.tokens = Math.max(-capacity, b.tokens - amount);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, b] of this.buckets) {
      if (now - b.at >= MINUTE) this.buckets.delete(id);
    }
    if (this.buckets.size >= MAX_KEYS) this.buckets.clear();
  }
}

export function createRateLimiter(core: Pick<Core, 'config' | 'now'>): RateLimiter {
  const r = core.config.limits.ratePerMinute;
  const l = core.config.limits;
  return new RateLimiter(
    (cls) => (cls === 'auth_fail' ? l.authFailuresPerMinute : cls === 'read_bytes' ? l.readBytesPerMinute : cls === 'poll' ? l.pollPerMinute : r[cls]),
    () => core.now(),
  );
}
