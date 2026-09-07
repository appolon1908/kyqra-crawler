import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import {
  HostRateLimitError,
  HostRateLimiter,
  isThrottlingStatus,
  parseRetryAfter,
} from '../../src/frontier/rate-limit.js';

interface StoredValue {
  value: string;
  expiresAt: number;
}

/**
 * The subset of Redis the limiter uses outside its Lua script, with real expiry semantics.
 * The token bucket itself runs server-side and is exercised against a real Redis in the
 * integration suite; here `eval` records the parameters the bucket would be driven with.
 */
class FakeRedis {
  public readonly evals: Array<{ key: string; capacity: number; refillPerMs: number }> = [];
  public evalResult = 0;
  private readonly store = new Map<string, StoredValue>();
  private clock = 1_000_000;

  advance(ms: number): void {
    this.clock += ms;
  }

  now(): number {
    return this.clock;
  }

  private live(key: string): StoredValue | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, unit?: string, amount?: number): Promise<'OK'> {
    const ttlMs =
      unit === 'EX' ? Number(amount) * 1_000 : unit === 'PX' ? Number(amount) : 3_600_000;
    this.store.set(key, { value, expiresAt: this.clock + ttlMs });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.live(key)?.value ?? '0') + 1;
    this.store.set(key, {
      value: String(next),
      expiresAt: this.live(key)?.expiresAt ?? this.clock + 3_600_000,
    });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = this.clock + seconds * 1_000;
    return 1;
  }

  async exists(key: string): Promise<number> {
    return this.live(key) ? 1 : 0;
  }

  async pttl(key: string): Promise<number> {
    const entry = this.live(key);
    return entry ? entry.expiresAt - this.clock : -2;
  }

  async eval(_script: string, _keys: number, key: string, ...args: string[]): Promise<number> {
    this.evals.push({
      key,
      capacity: Number(args[0]),
      refillPerMs: Number(args[1]),
    });
    return this.evalResult;
  }
}

const build = (
  overrides: Partial<ConstructorParameters<typeof HostRateLimiter>[0]> = {},
): { limiter: HostRateLimiter; redis: FakeRedis; slept: number[] } => {
  const redis = new FakeRedis();
  const slept: number[] = [];
  const limiter = new HostRateLimiter({
    redis: redis as unknown as Redis,
    defaultRps: 4,
    now: () => redis.now(),
    sleep: async (ms) => {
      slept.push(ms);
      redis.advance(ms);
    },
    ...overrides,
  });
  return { limiter, redis, slept };
};

describe('shared per-host rate limiting', () => {
  it('reads Retry-After as delta-seconds or an HTTP date', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(['30'], now)).toBe(30_000);
    expect(parseRetryAfter('Mon, 07 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
    // A date already in the past means "retry now", not a negative wait.
    expect(parseRetryAfter('Mon, 07 Sep 2026 11:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(undefined, now)).toBe(0);
    expect(parseRetryAfter('not-a-date', now)).toBe(0);
  });

  it('treats only throttling statuses as a signal to slow down', () => {
    expect([429, 503, 509].map(isThrottlingStatus)).toEqual([true, true, true]);
    expect([200, 404, 500, undefined].map(isThrottlingStatus)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('takes the most restrictive of the configured rate, crawl-delay, and default', () => {
    const { limiter } = build();
    expect(limiter.configuredRps('plain.test')).toBe(4);
    limiter.configureHost('slow.test', { minIntervalMs: 2_000, maxRps: 10 });
    expect(limiter.configuredRps('slow.test')).toBe(0.5);
    limiter.configureHost('capped.test', { maxRps: 1 });
    expect(limiter.configuredRps('capped.test')).toBe(1);
    limiter.configureHost('both.test', { minIntervalMs: 100, maxRps: 0.25 });
    expect(limiter.configuredRps('both.test')).toBe(0.25);
  });

  it('drives the bucket with the host rate, and halves it after a failure', async () => {
    const { limiter, redis } = build();
    limiter.configureHost('shop.test', { maxRps: 4 });

    await limiter.acquire('shop.test');
    expect(redis.evals.at(-1)?.refillPerMs).toBeCloseTo(0.004, 6);

    await limiter.recordFailure('shop.test', { statusCode: 500 });
    await limiter.acquire('shop.test');
    expect(redis.evals.at(-1)?.refillPerMs).toBeCloseTo(0.002, 6);

    await limiter.recordFailure('shop.test', { statusCode: 500 });
    await limiter.acquire('shop.test');
    expect(redis.evals.at(-1)?.refillPerMs).toBeCloseTo(0.001, 6);
  });

  it('never reduces a host below the configured floor', async () => {
    const { limiter, redis } = build({ minRateFraction: 0.25, failureThreshold: 50 });
    limiter.configureHost('fragile.test', { maxRps: 4 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await limiter.recordFailure('fragile.test', {});
    }
    await limiter.acquire('fragile.test');
    // 4 rps floored at 25% is 1 rps, i.e. one token per 1000 ms.
    expect(redis.evals.at(-1)?.refillPerMs).toBeCloseTo(0.001, 6);
  });

  it('recovers the rate after a success and clears the failure streak', async () => {
    const { limiter, redis } = build({ failureThreshold: 3 });
    limiter.configureHost('recovering.test', { maxRps: 4 });
    await limiter.recordFailure('recovering.test', {});
    await limiter.recordFailure('recovering.test', {});
    expect(await limiter.isCircuitOpen('recovering.test')).toBe(false);

    await limiter.recordSuccess('recovering.test');
    await limiter.acquire('recovering.test');
    // 1 rps recovered by 1.5x is 1.5 rps, still under the configured 4.
    expect(redis.evals.at(-1)?.refillPerMs).toBeCloseTo(0.0015, 6);

    // The streak was cleared, so two more failures still do not open the circuit.
    await limiter.recordFailure('recovering.test', {});
    await limiter.recordFailure('recovering.test', {});
    expect(await limiter.isCircuitOpen('recovering.test')).toBe(false);
  });

  it('waits out a Retry-After cooldown before touching the bucket', async () => {
    const { limiter, redis, slept } = build();
    await limiter.recordFailure('busy.test', { statusCode: 429, retryAfterMs: 2_500 });
    expect((await limiter.inspect('busy.test')).cooldownMs).toBe(2_500);

    await limiter.acquire('busy.test');
    expect(slept).toContain(2_500);
    // The cooldown is consumed, so the next acquire does not wait again.
    slept.length = 0;
    await limiter.acquire('busy.test');
    expect(slept).toEqual([]);
    expect(redis.evals).toHaveLength(2);
  });

  it('opens the circuit after consecutive failures and refuses the host while it is open', async () => {
    const { limiter, redis } = build({ failureThreshold: 3, circuitSeconds: 30 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.recordFailure('down.test', { statusCode: 503 });
    }
    expect(await limiter.isCircuitOpen('down.test')).toBe(true);
    await expect(limiter.acquire('down.test')).rejects.toBeInstanceOf(HostRateLimitError);

    redis.advance(31_000);
    expect(await limiter.isCircuitOpen('down.test')).toBe(false);
    await expect(limiter.acquire('down.test')).resolves.toBeTypeOf('number');
  });

  it('stops waiting when the crawl is cancelled', async () => {
    const redis = new FakeRedis();
    const limiter = new HostRateLimiter({
      redis: redis as unknown as Redis,
      defaultRps: 1,
      now: () => redis.now(),
    });
    await limiter.recordFailure('slow.test', { statusCode: 429, retryAfterMs: 60_000 });
    const controller = new AbortController();
    const pending = limiter.acquire('slow.test', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});
