import type { Redis } from 'ioredis';

/**
 * Atomic token bucket. Tokens are allowed to go negative so that concurrent callers —
 * including callers in other replicas — each reserve a distinct slot and wait their turn,
 * instead of all observing an empty bucket and retrying together.
 */
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * refillPerMs)
local wait = 0
if tokens < 1 then
  wait = math.ceil((1 - tokens) / refillPerMs)
end
tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttl)
return wait
`;

export interface HostPolicy {
  /** Smallest permitted gap between requests, e.g. a robots.txt Crawl-delay. */
  minIntervalMs?: number;
  /** Ceiling on requests per second for the host. */
  maxRps?: number;
}

export interface HostRateLimiterOptions {
  redis: Redis;
  /** Requests per second used for a host with no explicit policy. */
  defaultRps?: number;
  /** Bucket capacity, i.e. how much burst is tolerated. */
  burst?: number;
  /** Consecutive failures that open the circuit for a host. */
  failureThreshold?: number;
  /** How long an open circuit refuses requests. */
  circuitSeconds?: number;
  /** Adaptive backoff never reduces a host below this fraction of its configured rate. */
  minRateFraction?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HostState {
  circuitOpen: boolean;
  cooldownMs: number;
  effectiveRps: number;
}

export class HostRateLimitError extends Error {
  constructor(public readonly host: string) {
    super('host_circuit_open');
    this.name = 'HostRateLimitError';
  }
}

const KEY_PREFIX = 'kyqra:host';
const bucketKey = (host: string): string => `${KEY_PREFIX}:bucket:${host}`;
const cooldownKey = (host: string): string => `${KEY_PREFIX}:cooldown:${host}`;
const circuitKey = (host: string): string => `${KEY_PREFIX}:circuit:${host}`;
const failureKey = (host: string): string => `${KEY_PREFIX}:failures:${host}`;
const rateKey = (host: string): string => `${KEY_PREFIX}:rate:${host}`;

export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      if (signal?.aborted) reject(new Error('aborted'));
      else resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Parse a `Retry-After` header, which is either delta-seconds or an HTTP date.
 */
export const parseRetryAfter = (value: string | string[] | undefined, now = Date.now()): number => {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw) * 1_000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
};

/** Status codes that mean "you are asking too often", as opposed to a page-level error. */
export const isThrottlingStatus = (status: number | undefined): boolean =>
  status === 429 || status === 503 || status === 509;

export class HostRateLimiter {
  private readonly redis: Redis;
  private readonly defaultRps: number;
  private readonly burst: number;
  private readonly failureThreshold: number;
  private readonly circuitSeconds: number;
  private readonly minRateFraction: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly policies = new Map<string, HostPolicy>();

  constructor(options: HostRateLimiterOptions) {
    this.redis = options.redis;
    this.defaultRps = options.defaultRps ?? 2;
    this.burst = Math.max(1, options.burst ?? 1);
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.circuitSeconds = Math.max(1, options.circuitSeconds ?? 60);
    this.minRateFraction = Math.min(1, Math.max(0.01, options.minRateFraction ?? 0.125));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
  }

  /** Record the crawl policy for a host, e.g. from robots.txt or the `domains` table. */
  configureHost(host: string, policy: HostPolicy): void {
    this.policies.set(host, policy);
  }

  /** Requests per second permitted for a host before adaptive backoff is applied. */
  configuredRps(host: string): number {
    const policy = this.policies.get(host);
    const fromInterval = policy?.minIntervalMs ? 1_000 / policy.minIntervalMs : undefined;
    const candidates = [policy?.maxRps, fromInterval, this.defaultRps].filter(
      (value): value is number => typeof value === 'number' && value > 0,
    );
    return Math.min(...candidates);
  }

  private async effectiveRps(host: string): Promise<number> {
    const configured = this.configuredRps(host);
    const stored = await this.redis.get(rateKey(host));
    const adaptive = stored === null ? configured : Number(stored);
    if (!Number.isFinite(adaptive) || adaptive <= 0) return configured;
    return Math.min(configured, Math.max(configured * this.minRateFraction, adaptive));
  }

  /**
   * Wait until this replica may fetch from the host. Throws {@link HostRateLimitError}
   * while the host's circuit is open, and rejects if the signal aborts first.
   */
  async acquire(host: string, signal?: AbortSignal): Promise<number> {
    if (await this.isCircuitOpen(host)) throw new HostRateLimitError(host);
    const started = this.now();

    const cooldown = await this.redis.pttl(cooldownKey(host));
    if (cooldown > 0) await this.sleep(cooldown, signal);

    const rps = await this.effectiveRps(host);
    const refillPerMs = rps / 1_000;
    // Keep the bucket alive well past the time it takes to refill completely.
    const ttl = Math.ceil(Math.max(60_000, (this.burst / refillPerMs) * 2));
    const wait = await this.redis.eval(
      ACQUIRE_SCRIPT,
      1,
      bucketKey(host),
      String(this.burst),
      String(refillPerMs),
      String(this.now()),
      String(ttl),
    );
    const waitMs = Number(wait);
    if (Number.isFinite(waitMs) && waitMs > 0) await this.sleep(waitMs, signal);
    return this.now() - started;
  }

  async isCircuitOpen(host: string): Promise<boolean> {
    return (await this.redis.exists(circuitKey(host))) === 1;
  }

  /** A successful fetch clears the failure streak and lets the rate recover. */
  async recordSuccess(host: string): Promise<void> {
    const configured = this.configuredRps(host);
    await this.redis.del(failureKey(host));
    const stored = await this.redis.get(rateKey(host));
    if (stored === null) return;
    const recovered = Math.min(configured, Number(stored) * 1.5);
    if (!Number.isFinite(recovered) || recovered >= configured) {
      await this.redis.del(rateKey(host));
      return;
    }
    await this.redis.set(rateKey(host), String(recovered), 'EX', 600);
  }

  /**
   * A failed fetch halves the host's rate, honors any `Retry-After`, and opens the
   * circuit once the host has failed consecutively too many times.
   */
  async recordFailure(
    host: string,
    options: { statusCode?: number; retryAfterMs?: number } = {},
  ): Promise<void> {
    const configured = this.configuredRps(host);
    const stored = await this.redis.get(rateKey(host));
    const current = stored === null ? configured : Number(stored);
    const reduced = Math.max(
      configured * this.minRateFraction,
      (Number.isFinite(current) ? current : configured) / 2,
    );
    await this.redis.set(rateKey(host), String(reduced), 'EX', 600);

    const retryAfterMs = options.retryAfterMs ?? 0;
    if (retryAfterMs > 0) {
      await this.redis.set(cooldownKey(host), '1', 'PX', Math.ceil(retryAfterMs));
    }

    const failures = await this.redis.incr(failureKey(host));
    if (failures === 1) await this.redis.expire(failureKey(host), this.circuitSeconds * 4);
    if (failures >= this.failureThreshold) {
      await this.redis.set(circuitKey(host), '1', 'EX', this.circuitSeconds);
      await this.redis.del(failureKey(host));
    }
  }

  async inspect(host: string): Promise<HostState> {
    const [circuitOpen, cooldownMs, effectiveRps] = await Promise.all([
      this.isCircuitOpen(host),
      this.redis.pttl(cooldownKey(host)),
      this.effectiveRps(host),
    ]);
    return { circuitOpen, cooldownMs: Math.max(0, cooldownMs), effectiveRps };
  }
}

export const createHostRateLimiter = (options: HostRateLimiterOptions): HostRateLimiter =>
  new HostRateLimiter(options);
