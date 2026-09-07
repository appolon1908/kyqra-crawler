import http from 'node:http';

import { chromium, type Browser } from 'playwright';

import { createPinnedCrawlProxy } from '../delivery/pinned-proxy.js';

const upstream = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<main id="kyqra-browser-smoke">ready</main>');
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('fixture_bind_failed');
const proxy = await createPinnedCrawlProxy(async (rawUrl) => ({
  hostname: new URL(rawUrl).hostname,
  addresses: [{ address: '127.0.0.1', family: 4 }],
}));
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
    proxy: { server: proxy.url },
  });
  const page = await browser.newPage();
  const response = await page.goto(
    `http://dns-must-not-resolve.invalid:${upstreamAddress.port}/smoke`,
  );
  if (response?.status() !== 200) {
    throw new Error(`browser_smoke_status_${String(response?.status() || 'missing')}`);
  }
  const content = await page.content();
  if (!content.includes('<main id="kyqra-browser-smoke">ready</main>')) {
    throw new Error('browser_smoke_content_mismatch');
  }
  console.log('KYQRA_BROWSER_ENGINE_SMOKE=PASS');
} finally {
  await browser?.close();
  await proxy.close();
  await new Promise<void>((resolve, reject) =>
    upstream.close((error) => (error ? reject(error) : resolve())),
  );
}
