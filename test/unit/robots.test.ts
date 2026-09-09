import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createCrawlTargetResolver } from '../../src/delivery/security.js';
import {
  createGuardedRobotsFetcher,
  createRobotsCache,
  normalizeMatchPath,
  parseRobotsTxt,
  policyFromFetch,
  robotsUrlFor,
  robotsWarmupOrigins,
  type RobotsFetchResult,
} from '../../src/frontier/robots.js';

const startServer = async (
  handler: http.RequestListener,
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server: Server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('robots.txt evaluation', () => {
  afterEach(() => {
    delete process.env.ROBOTS_MAX_CRAWL_DELAY_SECONDS;
    delete process.env.KYQRA_ALLOW_TEST_TARGETS;
  });

  it('applies the most specific rule and lets Allow break ties', () => {
    const policy = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /private', 'Allow: /private/public', 'Disallow: /tmp'].join(
        '\n',
      ),
    );
    expect(policy.isAllowed('https://example.test/')).toBe(true);
    expect(policy.isAllowed('https://example.test/private/report')).toBe(false);
    expect(policy.isAllowed('https://example.test/private/public/report')).toBe(true);
    expect(policy.isAllowed('https://example.test/tmp/a')).toBe(false);
  });

  it('honors wildcard and end-anchored patterns against the path and query', () => {
    const policy = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /search?', 'Allow: /docs/*/public'].join(
        '\n',
      ),
    );
    expect(policy.isAllowed('https://example.test/manual.pdf')).toBe(false);
    expect(policy.isAllowed('https://example.test/manual.pdf.html')).toBe(true);
    expect(policy.isAllowed('https://example.test/search?q=1')).toBe(false);
    expect(policy.isAllowed('https://example.test/docs/v2/public')).toBe(true);
  });

  it('treats an empty Disallow as a permissive no-op', () => {
    const policy = parseRobotsTxt(['User-agent: *', 'Disallow:'].join('\n'));
    expect(policy.rules).toEqual([]);
    expect(policy.isAllowed('https://example.test/anything')).toBe(true);
  });

  it('selects the most specific matching user-agent group over the wildcard group', () => {
    const content = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: KyqraCrawler',
      'Disallow: /admin',
      'Crawl-delay: 4',
    ].join('\n');
    const kyqra = parseRobotsTxt(content, 'KyqraCrawler');
    expect(kyqra.isAllowed('https://example.test/catalog')).toBe(true);
    expect(kyqra.isAllowed('https://example.test/admin/users')).toBe(false);
    expect(kyqra.crawlDelaySeconds).toBe(4);
    expect(parseRobotsTxt(content, 'OtherBot').isAllowed('https://example.test/catalog')).toBe(
      false,
    );
  });

  it('ignores comments and collects sitemap declarations', () => {
    const policy = parseRobotsTxt(
      [
        '# leading comment',
        'Sitemap: https://example.test/sitemap.xml',
        'User-agent: * # inline comment',
        'Disallow: /secret',
        'Sitemap: https://example.test/news-sitemap.xml',
      ].join('\n'),
    );
    expect(policy.sitemaps).toEqual([
      'https://example.test/sitemap.xml',
      'https://example.test/news-sitemap.xml',
    ]);
    expect(policy.isAllowed('https://example.test/secret')).toBe(false);
  });

  it('ignores an empty user-agent token instead of matching every crawler', () => {
    const policy = parseRobotsTxt(
      ['User-agent:', 'Disallow: /', '', 'User-agent: *', 'Disallow: /blocked'].join('\n'),
    );
    expect(policy.isAllowed('https://example.test/open')).toBe(true);
    expect(policy.isAllowed('https://example.test/blocked')).toBe(false);
  });

  it('collapses repeated wildcards without changing the matched paths', () => {
    const policy = parseRobotsTxt(['User-agent: *', 'Disallow: /a**********b'].join('\n'));
    expect(policy.isAllowed('https://example.test/a-x-b')).toBe(false);
    expect(policy.isAllowed('https://example.test/a-x-c')).toBe(true);
  });

  it('matches a rule against percent-encoded unreserved octets', () => {
    // RFC 9309 section 2.2.2 compares paths with unreserved escapes decoded, and servers
    // route /private and /%70rivate to the same resource.
    const policy = parseRobotsTxt(['User-agent: *', 'Disallow: /private'].join('\n'));
    expect(policy.isAllowed('https://example.test/private/report')).toBe(false);
    expect(policy.isAllowed('https://example.test/%70rivate/report')).toBe(false);
    expect(policy.isAllowed('https://example.test/%50RIVATE')).toBe(true);

    // A rule written with an escape still covers the decoded path.
    const encodedRule = parseRobotsTxt(['User-agent: *', 'Disallow: /%70rivate'].join('\n'));
    expect(encodedRule.isAllowed('https://example.test/private')).toBe(false);

    // Reserved octets keep their escape; %2F is a separator, not a slash to decode.
    expect(normalizeMatchPath('/a%2Fb')).toBe('/a%2Fb');
    expect(normalizeMatchPath('/%7Euser/%2Dx')).toBe('/~user/-x');
  });

  it('merges every group that names the crawler, not just the first', () => {
    // RFC 9309 section 2.2.1 requires records for the same product token to be combined.
    const content = [
      'User-agent: KyqraCrawler',
      'Disallow: /first',
      'Crawl-delay: 2',
      '',
      'User-agent: KyqraCrawler',
      'Disallow: /second',
      'Crawl-delay: 5',
      '',
      'User-agent: *',
      'Disallow: /',
    ].join('\n');
    const policy = parseRobotsTxt(content, 'KyqraCrawler');
    expect(policy.isAllowed('https://example.test/first')).toBe(false);
    // Declared only in the later block, and previously crawled.
    expect(policy.isAllowed('https://example.test/second')).toBe(false);
    expect(policy.isAllowed('https://example.test/open')).toBe(true);
    // Merged records can each declare a delay; the most conservative wins.
    expect(policy.crawlDelaySeconds).toBe(5);
  });

  it('keeps applying the last known policy once an entry passes its TTL', async () => {
    let fetches = 0;
    let clock = 1_000;
    const cache = createRobotsCache({
      ttlSeconds: 10,
      now: () => clock,
      fetch: async (): Promise<RobotsFetchResult> => {
        fetches += 1;
        return { status: 200, body: 'User-agent: *\nDisallow: /blocked' };
      },
    });
    await cache.policyFor('https://slow.test/');
    expect(cache.isAllowedCached('https://slow.test/open')).toBe(true);

    clock += 11_000;
    // A crawl outliving the TTL must not silently stop enqueuing an allowed origin.
    expect(cache.isKnown('https://slow.test/open')).toBe(true);
    expect(cache.isAllowedCached('https://slow.test/open')).toBe(true);
    expect(cache.isAllowedCached('https://slow.test/blocked')).toBe(false);

    await cache.policyFor('https://slow.test/open');
    expect(fetches).toBe(2);
  });

  it('separates an origin never fetched from one whose entry is merely stale', async () => {
    const cache = createRobotsCache({
      fetch: async (): Promise<RobotsFetchResult> => ({ status: 200, body: '' }),
    });
    expect(cache.isKnown('https://unseen.test/a')).toBe(false);
    expect(cache.isAllowedCached('https://unseen.test/a')).toBe(false);
    await cache.policyFor('https://unseen.test/a');
    expect(cache.isKnown('https://unseen.test/a')).toBe(true);
    expect(cache.isKnown('not-a-url')).toBe(false);
  });

  it('warms the sibling scheme of a seed host so its links are not dropped', () => {
    expect(robotsWarmupOrigins('http://example.test/start')).toEqual([
      'http://example.test',
      'https://example.test',
    ]);
    expect(robotsWarmupOrigins('https://example.test/start')).toEqual([
      'https://example.test',
      'http://example.test',
    ]);
    // An explicit port has no standard sibling worth probing.
    expect(robotsWarmupOrigins('http://127.0.0.1:8080/start')).toEqual(['http://127.0.0.1:8080']);
  });

  it('caps a hostile crawl-delay at the configured ceiling', () => {
    process.env.ROBOTS_MAX_CRAWL_DELAY_SECONDS = '5';
    const policy = parseRobotsTxt(['User-agent: *', 'Crawl-delay: 86400'].join('\n'));
    expect(policy.crawlDelaySeconds).toBe(5);
  });

  it('allows everything on 404 and denies everything when the origin is unreachable', () => {
    expect(policyFromFetch({ status: 404, body: '' }).isAllowed('https://example.test/a')).toBe(
      true,
    );
    expect(policyFromFetch({ status: 503, body: '' }).isAllowed('https://example.test/a')).toBe(
      false,
    );
    expect(
      policyFromFetch({ status: 200, body: 'User-agent: *\nDisallow: /x' }).isAllowed(
        'https://example.test/x',
      ),
    ).toBe(false);
  });

  it('caches one fetch per origin, dedupes concurrent loads, and refetches after the TTL', async () => {
    let fetches = 0;
    let clock = 1_000;
    const cache = createRobotsCache({
      ttlSeconds: 10,
      now: () => clock,
      fetch: async (): Promise<RobotsFetchResult> => {
        fetches += 1;
        return { status: 200, body: 'User-agent: *\nDisallow: /private\nCrawl-delay: 2' };
      },
    });

    const [first, second] = await Promise.all([
      cache.policyFor('https://example.test/a'),
      cache.policyFor('https://example.test/b'),
    ]);
    expect(fetches).toBe(1);
    expect(first.isAllowed('https://example.test/private')).toBe(false);
    expect(second.isAllowed('https://example.test/open')).toBe(true);

    await cache.policyFor('https://example.test/c');
    expect(fetches).toBe(1);
    expect(cache.maxCrawlDelaySeconds()).toBe(2);

    clock += 11_000;
    // An expired entry is stale, not absent: the synchronous path keeps applying the last
    // known answer while the asynchronous path refetches it.
    expect(cache.peek('https://example.test/a')).toBeDefined();
    await cache.policyFor('https://example.test/a');
    expect(fetches).toBe(2);
  });

  it('fails closed for enqueue decisions on origins that were never fetched', async () => {
    const cache = createRobotsCache({
      fetch: async (): Promise<RobotsFetchResult> => ({
        status: 200,
        body: 'User-agent: *\nDisallow: /blocked',
      }),
    });
    expect(cache.isAllowedCached('https://known.test/open')).toBe(false);
    await cache.policyFor('https://known.test/');
    expect(cache.isAllowedCached('https://known.test/open')).toBe(true);
    expect(cache.isAllowedCached('https://known.test/blocked')).toBe(false);
    expect(cache.isAllowedCached('https://unknown.test/open')).toBe(false);
    expect(cache.isAllowedCached('not-a-url')).toBe(false);
  });

  it('denies the origin when robots.txt retrieval throws', async () => {
    const cache = createRobotsCache({
      fetch: async (): Promise<RobotsFetchResult> => {
        throw new Error('connection_reset');
      },
    });
    const policy = await cache.policyFor('https://broken.test/page');
    expect(policy.isAllowed('https://broken.test/page')).toBe(false);
  });

  it('fetches robots.txt over the guarded dispatcher and aggregates sitemaps', async () => {
    process.env.KYQRA_ALLOW_TEST_TARGETS = 'true';
    const site = await startServer((request, response) => {
      if (request.url === '/robots.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('User-agent: *\nDisallow: /private\nSitemap: https://example.test/s.xml\n');
        return;
      }
      response.writeHead(404).end();
    });
    try {
      const cache = createRobotsCache({ resolveTarget: createCrawlTargetResolver() });
      const policy = await cache.policyFor(`${site.baseUrl}/landing`);
      expect(policy.isAllowed(`${site.baseUrl}/landing`)).toBe(true);
      expect(policy.isAllowed(`${site.baseUrl}/private/x`)).toBe(false);
      expect(cache.sitemaps()).toEqual(['https://example.test/s.xml']);
    } finally {
      await site.close();
    }
  });

  it('rejects a robots.txt redirect that leaves the permitted target policy', async () => {
    process.env.KYQRA_ALLOW_TEST_TARGETS = 'true';
    const site = await startServer((_request, response) => {
      response.writeHead(302, { location: 'http://metadata.google.internal/robots.txt' }).end();
    });
    try {
      const fetchRobots = createGuardedRobotsFetcher(createCrawlTargetResolver());
      await expect(fetchRobots(robotsUrlFor(`${site.baseUrl}/`))).rejects.toThrow('denied');
    } finally {
      await site.close();
    }
  });
});
