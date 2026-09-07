import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { jobSpecSchema } from '../../src/config/schema.js';
import { dashboardHtml } from '../../src/api/dashboard.js';
import {
  browserConcurrency,
  crawlWorkerKind,
  databaseUrl,
  httpConcurrency,
  integrationCredentials,
  jobConcurrency,
  redisConnectionOptions,
} from '../../src/config/env.js';
import {
  callbackSignatureInput,
  crawlWebSocketGuardTarget,
  createPinnedCallbackAgent,
  isCallbackAllowed,
  isProhibitedAddress,
} from '../../src/delivery/security.js';
import { createPinnedCrawlProxy } from '../../src/delivery/pinned-proxy.js';
import { extractGenericData } from '../../src/extract/generic.js';
import { canonicalizeUrl, urlHash } from '../../src/frontier/canonicalize.js';

describe('crawler core behavior', () => {
  it('assembles dashboard assets into the served document', () => {
    const dashboard = dashboardHtml();
    expect(dashboard).toContain('async function go()');
    expect(dashboard).toContain('background: #101827');
    expect(dashboard).not.toContain('__KYQRA_');
  });

  it('canonicalizes tracking URLs and hashes the canonical form', () => {
    const canonical = canonicalizeUrl('HTTPS://EXAMPLE.COM/path/?utm_source=test&b=2#fragment');
    expect(canonical).toBe('https://example.com/path?b=2');
    expect(urlHash('HTTPS://EXAMPLE.COM/path/?utm_source=test&b=2#fragment')).toHaveLength(64);
  });

  it('parses defaults and rejects unsafe job bounds', () => {
    const parsed = jobSpecSchema.parse({ startUrls: ['https://example.test'] });
    expect(parsed).toMatchObject({ mode: 'single', maxPages: 100, browser: 'auto' });
    expect(() =>
      jobSpecSchema.parse({ startUrls: ['https://example.test'], maxPages: 10_001 }),
    ).toThrow();
  });

  it('extracts generic contact and JSON-LD fields from fixture HTML', () => {
    const extracted = extractGenericData(
      `<html><head><title>Fixture</title><meta property="og:site_name" content="Fixture Co">
       <script type="application/ld+json">{"@type":"Organization"}</script></head>
       <body><p>SALES@FIXTURE.TEST +1 (555) 123-4567</p><address>Test Way</address></body></html>`,
      'https://fixture.test/about',
    );
    expect(extracted.business_name).toBe('Fixture Co');
    expect(extracted.email).toEqual(['sales@fixture.test']);
    expect(extracted.phone).toEqual(['+15551234567']);
    expect(extracted.schema_org).toEqual([{ '@type': 'Organization' }]);
    expect(extracted.source_url).toBe('https://fixture.test/about');
  });

  it('enforces callback allowlisting, IP denial, and stable HMAC input', () => {
    process.env.CALLBACK_ALLOWLIST = 'hooks.example.test,10.40.0.1';
    expect(isCallbackAllowed('https://hooks.example.test/events')).toBe(true);
    expect(isCallbackAllowed('https://evil.test/events')).toBe(false);
    expect(isCallbackAllowed('http://hooks.example.test/events')).toBe(false);
    expect(isProhibitedAddress('127.0.0.1')).toBe(true);
    expect(isProhibitedAddress('192.168.1.1')).toBe(true);
    expect(isProhibitedAddress('8.8.8.8')).toBe(false);
    expect(isProhibitedAddress('::1')).toBe(true);
    expect(isProhibitedAddress('ff02::1')).toBe(true);
    expect(isProhibitedAddress('ff05::1')).toBe(true);
    expect(isProhibitedAddress('::ffff:7f00:1')).toBe(true);
    expect(isProhibitedAddress('::ffff:0808:0808')).toBe(false);
    expect(isProhibitedAddress('2001:4860:4860::8888')).toBe(false);
    expect(callbackSignatureInput('post', '//events//done', '1', '2', 'kyqra', '{}')).toMatch(
      /^v1\nPOST\n\/events\/done\n1\n2\nkyqra\n[0-9a-f]{64}$/,
    );
  });

  it('maps WebSocket targets onto the same SSRF guard policy', () => {
    expect(crawlWebSocketGuardTarget('ws://example.test/socket')).toBe(
      'http://example.test/socket',
    );
    expect(crawlWebSocketGuardTarget('wss://example.test/socket')).toBe(
      'https://example.test/socket',
    );
    expect(() => crawlWebSocketGuardTarget('https://example.test/socket')).toThrow(
      'crawl_target_denied',
    );
  });

  it('forwards browser traffic to the exact address returned by the target policy', async () => {
    const upstream = http.createServer((_request, response) => response.end('pinned-response'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    expect(upstreamAddress && typeof upstreamAddress !== 'string').toBe(true);
    if (!upstreamAddress || typeof upstreamAddress === 'string')
      throw new Error('fixture_bind_failed');
    const resolvedTargets: string[] = [];
    const proxy = await createPinnedCrawlProxy(async (rawUrl) => {
      resolvedTargets.push(rawUrl);
      return {
        hostname: new URL(rawUrl).hostname,
        addresses: [{ address: '127.0.0.1', family: 4 }],
      };
    });
    const proxyAddress = new URL(proxy.url);
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(
          {
            hostname: proxyAddress.hostname,
            port: proxyAddress.port,
            path: `http://dns-must-not-resolve.invalid:${upstreamAddress.port}/pinned`,
          },
          (response) => {
            let value = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (value += chunk));
            response.on('end', () => resolve(value));
          },
        )
        .on('error', reject);
    });
    expect(body).toBe('pinned-response');
    expect(resolvedTargets).toEqual([
      `http://dns-must-not-resolve.invalid:${upstreamAddress.port}/pinned`,
    ]);
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('routes WebSockets from every browser page through the pinned target proxy', async () => {
    let receivedPath = '';
    const upstream = http.createServer();
    upstream.on('upgrade', (request, socket) => {
      receivedPath = request.url || '';
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    expect(upstreamAddress && typeof upstreamAddress !== 'string').toBe(true);
    if (!upstreamAddress || typeof upstreamAddress === 'string')
      throw new Error('fixture_bind_failed');
    const resolvedTargets: string[] = [];
    const proxy = await createPinnedCrawlProxy(async (rawUrl) => {
      resolvedTargets.push(rawUrl);
      return {
        hostname: new URL(rawUrl).hostname,
        addresses: [{ address: '127.0.0.1', family: 4 }],
      };
    });
    const proxyAddress = new URL(proxy.url);
    await new Promise<void>((resolve, reject) => {
      const request = http.request({
        hostname: proxyAddress.hostname,
        port: proxyAddress.port,
        path: `ws://dns-must-not-resolve.invalid:${upstreamAddress.port}/socket`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });
      request.once('upgrade', (_response, socket) => {
        socket.destroy();
        resolve();
      });
      request.once('response', (response) =>
        reject(new Error(`unexpected_proxy_response_${response.statusCode ?? 0}`)),
      );
      request.once('error', reject);
      request.end();
    });
    expect(receivedPath).toBe('/socket');
    expect(resolvedTargets).toEqual([
      `http://dns-must-not-resolve.invalid:${upstreamAddress.port}/socket`,
    ]);
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('pins the documented internal callback exception without making a request', async () => {
    process.env.CALLBACK_ALLOWLIST = '10.40.0.1';
    const agent = await createPinnedCallbackAgent('http://10.40.0.1/events');
    await agent.close();
    await expect(createPinnedCallbackAgent('https://evil.test/events')).rejects.toThrow(
      'callback_not_allowed',
    );
  });

  it('parses environment concurrency and Redis settings with safe defaults', () => {
    delete process.env.REDIS_PASSWORD_FILE;
    delete process.env.REDIS_PASSWORD;
    process.env.REDIS_HOST = 'fixture-redis';
    process.env.REDIS_PORT = '6380';
    process.env.HTTP_CONCURRENCY = '4';
    process.env.BROWSER_CONCURRENCY = '2';
    process.env.JOB_CONCURRENCY = 'invalid';
    expect(redisConnectionOptions()).toMatchObject({ host: 'fixture-redis', port: 6380 });
    expect(httpConcurrency()).toBe(4);
    expect(browserConcurrency()).toBe(2);
    expect(jobConcurrency()).toBe(2);
    process.env.WORKER_KIND = 'http';
    expect(crawlWorkerKind()).toBe('http');
    process.env.WORKER_KIND = 'invalid';
    expect(() => crawlWorkerKind()).toThrow('WORKER_KIND');
    delete process.env.WORKER_KIND;
  });

  it('rejects Redis credentials that cannot be represented safely in an ACL', () => {
    delete process.env.REDIS_PASSWORD_FILE;
    process.env.REDIS_PASSWORD = 'contains spaces and shell metacharacters!';
    expect(() => redisConnectionOptions()).toThrow('URL-safe token');
    process.env.REDIS_PASSWORD = 'a'.repeat(32);
    expect(redisConnectionOptions()).toMatchObject({ password: 'a'.repeat(32) });
    delete process.env.REDIS_PASSWORD;
  });

  it('requires non-empty callback credentials and prevents conflicting secret sources', () => {
    delete process.env.KYQRA_MIDDLEWARE_API_KEY_FILE;
    delete process.env.KYQRA_WEBHOOK_SECRET_FILE;
    process.env.KYQRA_MIDDLEWARE_API_KEY = 'm'.repeat(32);
    process.env.KYQRA_WEBHOOK_SECRET = 'w'.repeat(32);
    expect(integrationCredentials()).toEqual({
      middlewareApiKey: 'm'.repeat(32),
      webhookSecret: 'w'.repeat(32),
    });
    process.env.KYQRA_WEBHOOK_SECRET_FILE = '/does/not/matter';
    expect(() => integrationCredentials()).toThrow('configure only');
    delete process.env.KYQRA_MIDDLEWARE_API_KEY;
    delete process.env.KYQRA_WEBHOOK_SECRET;
    delete process.env.KYQRA_WEBHOOK_SECRET_FILE;
  });

  it('supports file-backed database credentials without requiring an environment secret', () => {
    process.env.DATABASE_URL = 'postgresql://fixture.invalid/crawler';
    delete process.env.DATABASE_PASSWORD_FILE;
    expect(databaseUrl()).toBe('postgresql://fixture.invalid/crawler');
    process.env.DATABASE_PASSWORD_FILE = '/does/not/matter';
    expect(() => databaseUrl()).toThrow('configure only');
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PASSWORD_FILE;
  });
});
