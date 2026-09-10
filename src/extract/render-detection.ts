import { load } from 'cheerio';

import type { ExtractionData } from './generic.js';

/** Why a page was judged to need a rendered browser. Recorded as escalation evidence. */
export interface RenderSignals {
  /** Visible text characters in `<body>` after collapsing whitespace. */
  textLength: number;
  /** Characters of inline and referenced script markup. */
  scriptLength: number;
  /** A framework mount point that the server left empty. */
  emptyMountPoint: string | undefined;
  /** A `<noscript>` block telling the reader to enable JavaScript. */
  noscriptPrompt: boolean;
  /** No field that only real page content can supply was extracted. */
  contentEmpty: boolean;
}

export interface RenderVerdict {
  needsRendering: boolean;
  /** Stable identifier for the deciding signal, for evidence and metrics. */
  reason: string;
  signals: RenderSignals;
}

/** Mount points a single-page application leaves empty until its script runs. */
const MOUNT_POINT_SELECTORS = [
  '#root',
  '#app',
  '#__next',
  '#__nuxt',
  '[data-reactroot]',
  '[data-server-rendered]',
  'app-root',
];

/**
 * Below this, a page carries too little text to have delivered its content. Chosen well
 * under a thin but genuine page (a short contact page still runs to several hundred
 * characters) and well over an empty shell.
 */
const MINIMUM_TEXT_LENGTH = 240;

/** A page dominated this heavily by script, with little text, is a shell. */
const SCRIPT_TO_TEXT_RATIO = 3;

const NOSCRIPT_PROMPT =
  /enable\s+javascript|javascript\s+is\s+(?:required|disabled)|requires\s+javascript/i;

/**
 * True when nothing was extracted that only real page content can supply.
 *
 * `business_name` falls back to `<title>` and `description` reads a meta tag, and an empty
 * shell carries both, so counting them here would mask exactly the pages this exists to
 * catch. Only fields that require rendered content are considered.
 */
export const hasNoExtractedContent = (data: ExtractionData): boolean =>
  !data.address &&
  data.phone.length === 0 &&
  data.email.length === 0 &&
  data.schema_org.length === 0;

/**
 * Decide whether a page fetched over plain HTTP withheld its content pending JavaScript.
 *
 * `browser=auto` previously routed straight to the HTTP crawler and never rendered, so a
 * JavaScript-built page completed successfully with empty extraction — a silent wrong
 * answer rather than a visible failure. This inspects what the HTTP fetch actually
 * returned and reports both the verdict and the signals behind it, so an escalation is
 * explainable after the fact rather than a black box.
 */
export const detectRenderDependence = (html: string, data: ExtractionData): RenderVerdict => {
  const $ = load(html);
  // `.text()` descends into <script> and <style>, so measuring the body directly would
  // count the very bytes that mark a page as a shell as if they were its content.
  const visible = $('body').clone();
  visible.find('script, style, noscript, template').remove();
  const text = visible.text().replace(/\s+/g, ' ').trim();
  const scripts = $('script');
  let scriptLength = 0;
  scripts.each((_index, element) => {
    scriptLength += $(element).html()?.length ?? 0;
    scriptLength += ($(element).attr('src') ?? '').length;
  });

  const emptyMountPoint = MOUNT_POINT_SELECTORS.find((selector) => {
    const node = $(selector).first();
    if (node.length === 0) return false;
    return (node.text() ?? '').replace(/\s+/g, ' ').trim().length === 0;
  });

  const noscriptPrompt = $('noscript')
    .toArray()
    .some((element) => NOSCRIPT_PROMPT.test($(element).text()));

  const signals: RenderSignals = {
    textLength: text.length,
    scriptLength,
    emptyMountPoint,
    noscriptPrompt,
    contentEmpty: hasNoExtractedContent(data),
  };

  // An empty framework mount point is the least ambiguous signal: the server shipped a
  // container it never filled.
  if (emptyMountPoint) {
    return { needsRendering: true, reason: 'empty_mount_point', signals };
  }
  // The page says so itself.
  if (noscriptPrompt && signals.contentEmpty) {
    return { needsRendering: true, reason: 'noscript_prompt', signals };
  }
  // Mostly script, almost no prose, and nothing extracted: a shell that builds itself.
  if (
    signals.contentEmpty &&
    text.length < MINIMUM_TEXT_LENGTH &&
    scriptLength > text.length * SCRIPT_TO_TEXT_RATIO &&
    scriptLength > 0
  ) {
    return { needsRendering: true, reason: 'script_dominated_shell', signals };
  }
  return { needsRendering: false, reason: 'server_rendered', signals };
};
