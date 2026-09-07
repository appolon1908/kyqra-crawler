import { Job, Worker } from 'bullmq';
import { CheerioCrawler } from '@crawlee/cheerio';
import {
  Configuration,
  NonRetryableError,
  RequestQueue,
  type Request,
  type RequestOptions,
} from '@crawlee/core';
import { PlaywrightCrawler } from '@crawlee/playwright';

import { browserConcurrency, httpConcurrency, jobConcurrency } from '../config/env.js';
import { jobSpecSchema, type JobSpec } from '../config/schema.js';
import {
  createCrawlTargetResolver,
  createPinnedCrawlLookup,
  validateCrawlRedirectTarget,
} from '../delivery/security.js';
import { createPinnedCrawlProxy, type PinnedCrawlProxy } from '../delivery/pinned-proxy.js';
import { extractGenericData } from '../extract/generic.js';
import { canonicalizeUrl, urlHash } from '../frontier/canonicalize.js';
import { log } from '../observability/logger.js';
import {
  queueCompletionCallbacks,
  storedCompletionProgress,
  type CompletionProgress,
} from '../queues/completion-callbacks.js';
import { crawlQueueForKind } from '../queues/crawl.js';
import {
  countJobResults,
  getInternalJobState,
  getInternalJobStatus,
  insertResult,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
} from '../storage/postgres/repository.js';
import type { CrawlWorkerKind, Runtime } from '../types.js';

type CrawlProgress = CompletionProgress;

interface PageRequestData {
  depth?: number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const safeLogUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
};

const requestDepth = (request: Request): number => {
  const data = request.userData as PageRequestData;
  return typeof data.depth === 'number' ? data.depth : 0;
};

const shouldEnqueue = (url: string, roots: string[], spec: JobSpec): boolean =>
  roots.includes(new URL(url).hostname) &&
  !spec.excludePatterns.some((pattern) => url.includes(pattern)) &&
  (spec.includePatterns.length === 0 ||
    spec.includePatterns.some((pattern) => url.includes(pattern)));

const transformDiscoveredRequest = (
  request: RequestOptions,
  roots: string[],
  spec: JobSpec,
  depth: number,
): RequestOptions | false => {
  try {
    const normalized = canonicalizeUrl(request.url);
    if (!shouldEnqueue(normalized, roots, spec)) return false;
    request.url = normalized;
    request.userData = { depth: depth + 1 };
    return request;
  } catch {
    return false;
  }
};

const processPage = async (
  runtime: Runtime,
  job: Job<JobSpec>,
  jobId: string,
  request: Request,
  html: string,
  progress: CrawlProgress,
  guardTarget: (rawUrl: string) => Promise<void>,
): Promise<void> => {
  if ((await getInternalJobStatus(runtime.db, jobId)) !== 'running') {
    job.discard();
    throw new NonRetryableError('job_no_longer_running');
  }
  await guardTarget(request.loadedUrl || request.url);
  progress.processed += 1;
  const sourceUrl = request.loadedUrl || request.url;
  const data = extractGenericData(html, sourceUrl);
  const provenance = Object.fromEntries(Object.keys(data).map((key) => [key, request.url]));
  progress.records += await insertResult(
    runtime.db,
    jobId,
    request.url,
    urlHash(request.url),
    data,
    provenance,
  );
  await job.updateProgress(progress);
};

export const processCrawlJob = async (
  runtime: Runtime,
  job: Job<JobSpec>,
): Promise<CrawlProgress> => {
  const spec = jobSpecSchema.parse(job.data);
  const jobId = job.id;
  if (!jobId) throw new Error('job_id_required');
  const existing = await getInternalJobState(runtime.db, jobId);
  if (existing?.status === 'completed') {
    const completedProgress = storedCompletionProgress(existing.progress);
    await queueCompletionCallbacks(runtime, jobId, spec, completedProgress);
    return completedProgress;
  }
  const priorProgress = storedCompletionProgress(job.progress);
  const durableRecords = await countJobResults(runtime.db, jobId);
  const progress: CrawlProgress = {
    processed: durableRecords,
    records: durableRecords,
    failed: priorProgress.failed,
  };
  const resolveTarget = createCrawlTargetResolver();
  const guardTarget = async (rawUrl: string): Promise<void> => {
    await resolveTarget(rawUrl);
  };
  const routedPages = new WeakSet<object>();
  if (!(await markJobRunning(runtime.db, jobId))) {
    job.discard();
    throw new NonRetryableError('job_not_runnable');
  }
  const roots = spec.startUrls.map((url) => new URL(url).hostname);
  // The frontier is populated before crawler.run(). Crawlee purges local storage on the
  // first run by default, which would erase this named queue and incorrectly complete a
  // job with zero processed requests. A job-scoped configuration preserves its frontier
  // while retaining isolation from every other concurrently running job.
  const crawlConfiguration = new Configuration({ purgeOnStart: false, persistStorage: true });
  let requestQueue: RequestQueue | undefined;
  let pinnedProxy: PinnedCrawlProxy | undefined;
  const useBrowser = spec.browser === 'playwright';
  const commonOptions = {
    maxRequestsPerCrawl: spec.maxPages,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: useBrowser ? browserConcurrency() : httpConcurrency(),
    sameDomainDelaySecs: 1 / spec.requestsPerSecond,
    failedRequestHandler: async ({ request }: { request: Request }) => {
      progress.failed += 1;
      await job.updateProgress(progress);
      log('warn', 'request_failed', { jobId, url: safeLogUrl(request.url) });
    },
  };

  try {
    await Promise.all(spec.startUrls.map((url) => guardTarget(url)));
    requestQueue = await RequestQueue.open(`job-${jobId}-${job.timestamp}-${job.attemptsMade}`, {
      config: crawlConfiguration,
    });
    for (const url of spec.startUrls) {
      await requestQueue.addRequest({ url: canonicalizeUrl(url), userData: { depth: 0 } });
    }
    if (useBrowser) {
      pinnedProxy = await createPinnedCrawlProxy(resolveTarget);
      await new PlaywrightCrawler(
        {
          ...commonOptions,
          requestQueue,
          preNavigationHooks: [
            async ({ request, page }) => {
              if ((await getInternalJobStatus(runtime.db, jobId)) !== 'running') {
                job.discard();
                throw new NonRetryableError('job_no_longer_running');
              }
              await guardTarget(request.url);
              if (routedPages.has(page)) return;
              routedPages.add(page);
              // Every page, popup, iframe, and WebSocket remains confined to
              // the browser-wide pinned proxy. This route is a second policy
              // check; continue() cannot bypass the proxy's validated address.
              await page.route('**/*', async (route) => {
                const target = route.request().url();
                const protocol = new URL(target).protocol;
                if (protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') {
                  return route.continue();
                }
                try {
                  await guardTarget(target);
                  return route.continue();
                } catch {
                  return route.abort('blockedbyclient');
                }
              });
            },
          ],
          browserPoolOptions: {
            prePageCreateHooks: [
              (_pageId, _browserController, pageOptions) => {
                if (!pageOptions) throw new Error('browser_context_options_missing');
                pageOptions.serviceWorkers = 'block';
              },
            ],
          },
          launchContext: {
            proxyUrl: pinnedProxy.url,
            useIncognitoPages: true,
            launchOptions: { headless: true, args: ['--disable-dev-shm-usage'] },
          },
          requestHandler: async (context) => {
            const depth = requestDepth(context.request);
            const html = await context.page.content();
            await processPage(runtime, job, jobId, context.request, html, progress, guardTarget);
            if (depth < spec.maxDepth && spec.mode !== 'single') {
              await context.enqueueLinks({
                strategy: 'same-hostname',
                transformRequestFunction: (request) =>
                  transformDiscoveredRequest(request, roots, spec, depth),
              });
            }
          },
        },
        crawlConfiguration,
      ).run();
    } else {
      await new CheerioCrawler(
        {
          ...commonOptions,
          requestQueue,
          preNavigationHooks: [
            async ({ request }, gotOptions) => {
              if ((await getInternalJobStatus(runtime.db, jobId)) !== 'running') {
                job.discard();
                throw new NonRetryableError('job_no_longer_running');
              }
              await guardTarget(request.url);
              gotOptions.dnsLookup = await createPinnedCrawlLookup(request.url, resolveTarget);
              gotOptions.maxRedirects = 5;
              gotOptions.followRedirect = (response) => {
                const location = response.headers.location;
                if (!location) return false;
                validateCrawlRedirectTarget(location, response.url);
                return true;
              };
            },
          ],
          requestHandler: async (context) => {
            const depth = requestDepth(context.request);
            const html = Buffer.isBuffer(context.body)
              ? context.body.toString('utf8')
              : String(context.body);
            await processPage(runtime, job, jobId, context.request, html, progress, guardTarget);
            if (depth < spec.maxDepth && spec.mode !== 'single') {
              await context.enqueueLinks({
                strategy: 'same-hostname',
                transformRequestFunction: (request) =>
                  transformDiscoveredRequest(request, roots, spec, depth),
              });
            }
          },
        },
        crawlConfiguration,
      ).run();
    }
    progress.records = await countJobResults(runtime.db, jobId);
    progress.processed = progress.records;
    await job.updateProgress(progress);
    if (!(await markJobCompleted(runtime.db, jobId, progress))) {
      job.discard();
      throw new NonRetryableError('job_no_longer_running');
    }
    await queueCompletionCallbacks(runtime, jobId, spec, progress);
    return progress;
  } catch (error: unknown) {
    const configuredAttempts = Math.max(1, Number(job.opts.attempts ?? 1));
    const finalAttempt = job.attemptsMade + 1 >= configuredAttempts;
    if (finalAttempt || error instanceof NonRetryableError) {
      await markJobFailed(runtime.db, jobId, errorMessage(error));
    }
    throw error;
  } finally {
    await pinnedProxy?.close();
    await requestQueue?.drop().catch((error: unknown) => {
      log('warn', 'request_queue_cleanup_failed', { jobId, error: errorMessage(error) });
    });
  }
};

export const createCrawlWorker = (runtime: Runtime, kind: CrawlWorkerKind): Worker<JobSpec> =>
  new Worker<JobSpec>(
    crawlQueueForKind(runtime, kind).name,
    (job) => processCrawlJob(runtime, job),
    {
      connection: runtime.redisConnection,
      concurrency: jobConcurrency(),
    },
  );
