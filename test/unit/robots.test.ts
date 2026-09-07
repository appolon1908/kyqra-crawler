import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createCrawlTargetResolver } from '../../src/delivery/security.js';
import {
  createGuardedRobotsFetcher,
  createRobotsCache,
  parseRobotsTxt,
  policyFromFetch,
  robotsUrlFor,
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
    expect(cache.peek('https://example.test/a')).toBeUndefined();
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
