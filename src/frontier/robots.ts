import type { LookupFunction } from 'node:net';

import { Agent, request } from 'undici';

import {
  createPinnedCrawlLookup,
  validateCrawlRedirectTarget,
  type CrawlTargetResolver,
} from '../delivery/security.js';

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  /** True when the crawler's user agent may fetch the URL. */
  isAllowed: (rawUrl: string) => boolean;
  /** Seconds the crawler must wait between requests to the host, when declared. */
  crawlDelaySeconds: number | undefined;
  /** Sitemap URLs declared by the host, in declaration order. */
  sitemaps: string[];
  /** Rules of the group that applied to the configured user agent. */
  rules: RobotsRule[];
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
}

export interface RobotsFetchResult {
  status: number;
  body: string;
}

export type RobotsFetcher = (robotsUrl: string) => Promise<RobotsFetchResult>;

const DEFAULT_USER_AGENT = 'KyqraCrawler';
// RFC 9309 section 2.5 requires parsing at least 500 KiB of a robots.txt file.
const DEFAULT_MAX_BYTES = 512_000;
const DEFAULT_TTL_SECONDS = 3_600;
const DEFAULT_MAX_CRAWL_DELAY_SECONDS = 30;
const MAX_ROBOTS_REDIRECTS = 5;

const boundedNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const robotsUserAgent = (): string => process.env.ROBOTS_USER_AGENT || DEFAULT_USER_AGENT;

export const robotsCacheTtlSeconds = (): number =>
  boundedNumber(process.env.ROBOTS_CACHE_TTL_SECONDS, DEFAULT_TTL_SECONDS);

export const robotsMaxCrawlDelaySeconds = (): number =>
  boundedNumber(process.env.ROBOTS_MAX_CRAWL_DELAY_SECONDS, DEFAULT_MAX_CRAWL_DELAY_SECONDS);

export const robotsUrlFor = (rawUrl: string): string => new URL('/robots.txt', rawUrl).toString();

export const robotsOriginOf = (rawUrl: string): string => new URL(rawUrl).origin;

/**
 * Convert a robots.txt path pattern into an anchored expression. `*` matches any
 * sequence and a trailing `$` anchors the end of the path, per RFC 9309 section 2.2.3.
 */
const patternToRegExp = (pattern: string): RegExp => {
  const anchored = pattern.endsWith('$');
  // Runs of `*` are equivalent to a single `*`; collapsing them keeps a hostile
  // robots.txt from producing a pathologically backtracking expression.
  const body = (anchored ? pattern.slice(0, -1) : pattern).replaceAll(/\*+/g, '*');
  const escaped = body.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
};

const requestPath = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  return `${url.pathname}${url.search}`;
};

/**
 * Select the group whose product token best matches the crawler. The longest matching
 * token wins; `*` is the fallback group when no explicit token matches.
 */
const selectGroup = (groups: RobotsGroup[], userAgent: string): RobotsGroup | undefined => {
  const normalized = userAgent.toLowerCase();
  let best: RobotsGroup | undefined;
  let bestLength = -1;
  let wildcard: RobotsGroup | undefined;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        wildcard = wildcard ? { ...wildcard, rules: [...wildcard.rules, ...group.rules] } : group;
        continue;
      }
      // A `User-agent:` line with no token matches nothing; without this guard the
      // empty string would substring-match every crawler at specificity zero.
      if (!agent) continue;
      if (normalized.includes(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }
  return best ?? wildcard;
};

export const parseRobotsTxt = (content: string, userAgent = robotsUserAgent()): RobotsPolicy => {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  let previousWasAgent = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }
    previousWasAgent = false;

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty `Disallow` is an explicit no-op that permits the whole host.
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
      continue;
    }
    if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) {
        current.crawlDelaySeconds = Math.min(delay, robotsMaxCrawlDelaySeconds());
      }
    }
  }

  const group = selectGroup(groups, userAgent);
  const rules = group?.rules ?? [];
  const compiled = rules.map((rule) => ({ ...rule, matcher: patternToRegExp(rule.pattern) }));

  return {
    rules,
    sitemaps,
    crawlDelaySeconds: group?.crawlDelaySeconds,
    isAllowed: (rawUrl: string): boolean => {
      let path: string;
      try {
        path = requestPath(rawUrl);
      } catch {
        return false;
      }
      let decision = true;
      let bestLength = -1;
      for (const rule of compiled) {
        if (!rule.matcher.test(path)) continue;
        // The most specific rule wins; Allow breaks ties, per RFC 9309 section 2.2.2.
        if (rule.pattern.length > bestLength) {
          bestLength = rule.pattern.length;
          decision = rule.allow;
        } else if (rule.pattern.length === bestLength && rule.allow) {
          decision = true;
        }
      }
      return decision;
    },
  };
};

export const allowAllPolicy = (): RobotsPolicy => parseRobotsTxt('');

export const denyAllPolicy = (): RobotsPolicy => parseRobotsTxt('User-agent: *\nDisallow: /', '*');

const readBounded = async (body: AsyncIterable<unknown>, maxBytes: number): Promise<string> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array);
    chunks.push(buffer);
    total += buffer.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
};

/**
 * Fetch robots.txt through the same pinned-address policy that guards crawl targets.
 * Redirects are followed manually so every hop is revalidated before connecting.
 */
export const createGuardedRobotsFetcher =
  (resolveTarget: CrawlTargetResolver, maxBytes = DEFAULT_MAX_BYTES): RobotsFetcher =>
  async (robotsUrl: string): Promise<RobotsFetchResult> => {
    let target = robotsUrl;
    for (let hop = 0; hop <= MAX_ROBOTS_REDIRECTS; hop += 1) {
      const lookup: LookupFunction = await createPinnedCrawlLookup(target, resolveTarget);
      const agent = new Agent({ connect: { lookup } });
      try {
        // undici does not follow redirects unless a redirect handler is installed, so
        // every hop below is revalidated by this loop rather than by the dispatcher.
        const response = await request(target, {
          dispatcher: agent,
          headers: { 'user-agent': robotsUserAgent(), accept: 'text/plain' },
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
        });
        if (response.statusCode >= 300 && response.statusCode < 400) {
          const location = response.headers.location;
          const next = Array.isArray(location) ? location[0] : location;
          // Discard the redirect body without aborting the request, which would
          // surface as an unhandled AbortError on the dispatcher.
          await response.body.dump();
          if (!next) return { status: response.statusCode, body: '' };
          target = validateCrawlRedirectTarget(next, target);
          continue;
        }
        return { status: response.statusCode, body: await readBounded(response.body, maxBytes) };
      } finally {
        await agent.close();
      }
    }
    throw new Error('robots_redirect_limit');
  };

/**
 * Translate a robots.txt fetch outcome into a policy. RFC 9309 section 2.3.1 treats
 * "unavailable" (4xx) as full allow and "unreachable" (5xx or transport failure) as
 * full disallow, so an origin that cannot answer is never crawled.
 */
export const policyFromFetch = (
  result: RobotsFetchResult,
  userAgent = robotsUserAgent(),
): RobotsPolicy => {
  if (result.status >= 200 && result.status < 300) return parseRobotsTxt(result.body, userAgent);
  if (result.status >= 400 && result.status < 500) return allowAllPolicy();
  return denyAllPolicy();
};

export interface RobotsCacheOptions {
  resolveTarget?: CrawlTargetResolver;
  fetch?: RobotsFetcher;
  userAgent?: string;
  ttlSeconds?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface RobotsCache {
  /** Fetch (or reuse) the policy for the URL's origin. */
  policyFor: (rawUrl: string) => Promise<RobotsPolicy>;
  /** Cached policy for the URL's origin, without performing any network request. */
  peek: (rawUrl: string) => RobotsPolicy | undefined;
  /** Synchronous enqueue-time decision. Fails closed when the origin is not cached. */
  isAllowedCached: (rawUrl: string) => boolean;
  /** Sitemap URLs declared by every origin fetched so far. */
  sitemaps: () => string[];
  /** Largest crawl-delay declared by any origin fetched so far. */
  maxCrawlDelaySeconds: () => number;
}

interface CacheEntry {
  policy: RobotsPolicy;
  expiresAt: number;
}

export const createRobotsCache = (options: RobotsCacheOptions = {}): RobotsCache => {
  const userAgent = options.userAgent ?? robotsUserAgent();
  const ttlSeconds = options.ttlSeconds ?? robotsCacheTtlSeconds();
  const now = options.now ?? Date.now;
  const fetchRobots =
    options.fetch ??
    (options.resolveTarget
      ? createGuardedRobotsFetcher(options.resolveTarget, options.maxBytes ?? DEFAULT_MAX_BYTES)
      : undefined);
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<RobotsPolicy>>();

  const store = (origin: string, policy: RobotsPolicy): RobotsPolicy => {
    entries.set(origin, { policy, expiresAt: now() + ttlSeconds * 1_000 });
    return policy;
  };

  const live = (origin: string): RobotsPolicy | undefined => {
    const entry = entries.get(origin);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(origin);
      return undefined;
    }
    return entry.policy;
  };

  const policyFor = async (rawUrl: string): Promise<RobotsPolicy> => {
    const origin = robotsOriginOf(rawUrl);
    const cached = live(origin);
    if (cached) return cached;
    const inFlight = pending.get(origin);
    if (inFlight) return inFlight;
    if (!fetchRobots) return store(origin, denyAllPolicy());
    const load = fetchRobots(robotsUrlFor(rawUrl))
      .then(
        (result) => policyFromFetch(result, userAgent),
        // An origin whose robots.txt cannot be retrieved is treated as unreachable.
        () => denyAllPolicy(),
      )
      .then((policy) => store(origin, policy))
      .finally(() => pending.delete(origin));
    pending.set(origin, load);
    return load;
  };

  return {
    policyFor,
    peek: (rawUrl: string): RobotsPolicy | undefined => {
      try {
        return live(robotsOriginOf(rawUrl));
      } catch {
        return undefined;
      }
    },
    isAllowedCached: (rawUrl: string): boolean => {
      try {
        return live(robotsOriginOf(rawUrl))?.isAllowed(rawUrl) ?? false;
      } catch {
        return false;
      }
    },
    sitemaps: (): string[] => [
      ...new Set([...entries.values()].flatMap((entry) => entry.policy.sitemaps)),
    ],
    maxCrawlDelaySeconds: (): number =>
      [...entries.values()].reduce(
        (largest, entry) => Math.max(largest, entry.policy.crawlDelaySeconds ?? 0),
        0,
      ),
  };
};
