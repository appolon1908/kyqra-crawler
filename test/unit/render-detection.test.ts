import { describe, expect, it } from 'vitest';

import { extractGenericData } from '../../src/extract/generic.js';
import {
  detectRenderDependence,
  hasNoExtractedContent,
} from '../../src/extract/render-detection.js';

const verdictFor = (
  html: string,
  url = 'https://fixture.test/page',
): ReturnType<typeof detectRenderDependence> =>
  detectRenderDependence(html, extractGenericData(html, url));

const SERVER_RENDERED = `<!doctype html><html><head><title>Ridgeway Plumbing</title>
  <meta property="og:site_name" content="Ridgeway Plumbing"></head>
  <body><h1>Ridgeway Plumbing</h1>
  <p>We have served the Ridgeway area since 1994, covering emergency callouts,
  boiler servicing, bathroom installation and leak detection across the county.
  Our engineers are all Gas Safe registered and we answer the phone ourselves.</p>
  <p>Call us on +1 (555) 123-4567 or email hello@ridgeway.test to book a visit.</p>
  <address>18 Mill Lane, Ridgeway</address></body></html>`;

describe('render dependence detection', () => {
  it('leaves a server-rendered page on the HTTP fetcher', () => {
    const verdict = verdictFor(SERVER_RENDERED);
    expect(verdict.needsRendering).toBe(false);
    expect(verdict.reason).toBe('server_rendered');
    expect(verdict.signals.contentEmpty).toBe(false);
  });

  it('escalates a framework shell whose mount point is empty', () => {
    const verdict = verdictFor(
      `<!doctype html><html><head><title>App</title></head>
       <body><div id="root"></div>
       <script src="/static/bundle.a91f3c.js"></script></body></html>`,
    );
    expect(verdict.needsRendering).toBe(true);
    expect(verdict.reason).toBe('empty_mount_point');
    expect(verdict.signals.emptyMountPoint).toBe('#root');
  });

  it('recognises the mount points of the common frameworks', () => {
    for (const [markup, selector] of [
      ['<div id="app"></div>', '#app'],
      ['<div id="__next"></div>', '#__next'],
      ['<div id="__nuxt"></div>', '#__nuxt'],
      ['<div data-reactroot></div>', '[data-reactroot]'],
      ['<app-root></app-root>', 'app-root'],
    ] as const) {
      const verdict = verdictFor(`<html><body>${markup}<script>x()</script></body></html>`);
      expect([selector, verdict.signals.emptyMountPoint]).toEqual([selector, selector]);
    }
  });

  it('does not escalate a mount point the server already filled', () => {
    // Server-side rendering uses the same container; the content is the difference.
    const verdict = verdictFor(
      `<!doctype html><html><head><title>Ridgeway</title></head><body>
       <div id="root">${SERVER_RENDERED}</div>
       <script src="/static/bundle.js"></script></body></html>`,
    );
    expect(verdict.signals.emptyMountPoint).toBeUndefined();
    expect(verdict.needsRendering).toBe(false);
  });

  it('escalates when the page itself asks for JavaScript and nothing was extracted', () => {
    const verdict = verdictFor(
      `<html><body><noscript>You need to enable JavaScript to run this app.</noscript>
       <span></span><script>boot()</script></body></html>`,
    );
    expect(verdict.needsRendering).toBe(true);
    expect(verdict.reason).toBe('noscript_prompt');
    expect(verdict.signals.noscriptPrompt).toBe(true);
  });

  it('ignores a noscript notice on a page that did deliver its content', () => {
    const verdict = verdictFor(
      `${SERVER_RENDERED.replace('</body>', '<noscript>Please enable JavaScript for maps.</noscript></body>')}`,
    );
    expect(verdict.signals.noscriptPrompt).toBe(true);
    // The page carries real content, so the notice is incidental.
    expect(verdict.needsRendering).toBe(false);
  });

  it('escalates a script-dominated shell with no mount point of a known name', () => {
    const verdict = verdictFor(
      `<html><head><title>Shell</title></head><body><div class="mount"></div>
       <script>${'window.__BOOT__=1;'.repeat(60)}</script></body></html>`,
    );
    expect(verdict.needsRendering).toBe(true);
    expect(verdict.reason).toBe('script_dominated_shell');
    expect(verdict.signals.scriptLength).toBeGreaterThan(verdict.signals.textLength * 3);
  });

  it('leaves a genuinely thin page alone when it carries no script', () => {
    // A short page is not the same as a withheld page; escalating it would waste a browser.
    const verdict = verdictFor(
      '<html><head><title>Closed</title></head><body><p>We are closed.</p></body></html>',
    );
    expect(verdict.needsRendering).toBe(false);
    expect(verdict.signals.scriptLength).toBe(0);
  });

  it('ignores head metadata, which an empty shell carries too', () => {
    expect(hasNoExtractedContent(extractGenericData(SERVER_RENDERED, 'https://a.test/'))).toBe(
      false,
    );
    expect(
      hasNoExtractedContent(
        extractGenericData('<html><body><p>hi</p></body></html>', 'https://a.test/'),
      ),
    ).toBe(true);
    // A page with only structured data still counts as extracted.
    expect(
      hasNoExtractedContent(
        extractGenericData(
          `<html><body><script type="application/ld+json">{"@type":"Organization"}</script></body></html>`,
          'https://a.test/',
        ),
      ),
    ).toBe(false);
  });
});
