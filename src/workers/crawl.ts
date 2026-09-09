import { Job, Worker } from 'bullmq';
import { CheerioCrawler } from '@crawlee/cheerio';
import {
  Configuration,
  NonRetryableError,
  type Request,
  type RequestOptions,
  type RequestProvider,
} from '@crawlee/core';
import { PlaywrightCrawler } from '@crawlee/playwright';

import {
  browserConcurrency,
  frontierSweepSeconds,
  frontierVisibilitySeconds,
  httpConcurrency,
  jobConcurrency,
  workerIdentity,
} from '../config/env.js';
import { jobSpecSchema, type JobSpec } from '../config/schema.js';
import {
  createCrawlTargetResolver,
  createPinnedCrawlLookup,
  validateCrawlRedirectTarget,
} from '../delivery/security.js';
import { createPinnedCrawlProxy, type PinnedCrawlProxy } from '../delivery/pinned-proxy.js';
import { extractGenericData } from '../extract/generic.js';
import { detectRenderDependence } from '../extract/render-detection.js';
import { canonicalizeUrl, urlHash } from '../frontier/canonicalize.js';
import {
  HostRateLimitError,
  createHostRateLimiter,
  isThrottlingStatus,
  parseRetryAfter,
  type HostRateLimiter,
} from '../frontier/rate-limit.js';
import { PostgresFrontier } from '../frontier/request-manager.js';
import { createRobotsCache, robotsWarmupOrigins, type RobotsCache } from '../frontier/robots.js';
import { log } from '../observability/logger.js';
import {
  queueCompletionCallbacks,
  storedCompletionProgress,
  type CompletionProgress,
} from '../queues/completion-callbacks.js';
import { crawlQueueForKind } from '../queues/crawl.js';
import {
  countEscalatedFrontierRequests,
  deleteFrontier,
  escalateFrontierRequest,
  markFrontierFailed,
  releaseExpiredFrontierClaims,
  releaseWorkerFrontierClaims,
} from '../storage/postgres/frontier.js';
import {
  countJobResults,
  getDomainPolicies,
  recordEscalation,
  getInternalJobState,
  getInternalJobStatus,
  insertResult,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  type ResultFetcher,
} from '../storage/postgres/repository.js';
import type { CrawlWorkerKind, Runtime } from '../types.js';
import { watchJobCancellation, type CancellationWatch } from './cancellation.js';
import { createShutdownCoordinator, type ShutdownCoordinator } from './shutdown.js';

type CrawlProgress = CompletionProgress;

interface PageRequestData {
  depth?: number;
}

export interface CrawlJobOptions {
  workerId?: string;
  /** Which worker is running this attempt. An `auto` job renders only on `browser`. */
  kind?: CrawlWorkerKind;
  /** Aborts when the process is shutting down, so the job checkpoints instead of dying. */
  shutdownSignal?: AbortSignal;
  cancelPollIntervalMs?: number;
}

/** Raised when a job stops because the process is shutting down, not because it failed. */
export class CrawlInterruptedError extends Error {
  constructor() {
    super('crawl_interrupted_by_shutdown');
    this.name = 'CrawlInterruptedError';
  }
}

/**
 * Raised when an `auto` job hands itself to the browser worker. Like an interruption this
 * is not a failure: the job stays runnable, keeps its frontier, and resumes on the browser
 * queue, so it must not be recorded as failed or have its frontier deleted.
 */
export class CrawlEscalatedError extends Error {
  constructor(public readonly escalated: number) {
    super('crawl_escalated_to_browser');
    this.name = 'CrawlEscalatedError';
  }
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

const hostOf = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'invalid-host';
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
  robots: RobotsCache,
  jobId: string,
): RequestOptions | false => {
  try {
    const normalized = canonicalizeUrl(request.url);
    if (!shouldEnqueue(normalized, roots, spec)) return false;
    // Enqueue decisions are synchronous and cannot fetch, so an origin never loaded fails
    // closed. Say so rather than dropping the link silently.
    if (!robots.isKnown(normalized)) {
      log('warn', 'robots_origin_unknown', { jobId, url: safeLogUrl(normalized) });
      return false;
    }
    if (!robots.isAllowedCached(normalized)) return false;
    request.url = normalized;
    request.userData = { depth: depth + 1 };
    return request;
  } catch {
    return false;
  }
};

interface PageContext {
  /** Which fetcher produced this HTML. */
  fetcher: ResultFetcher;
  /** True when an unsatisfying HTTP result may be handed to the browser worker. */
  mayEscalate: boolean;
  /** Called when a page is judged to need rendering. */
  onEscalate: (
    request: Request,
    verdict: ReturnType<typeof detectRenderDependence>,
  ) => Promise<void>;
}

const processPage = async (
  runtime: Runtime,
  job: Job<JobSpec>,
  jobId: string,
  request: Request,
  html: string,
  progress: CrawlProgress,
  guardTarget: (rawUrl: string) => Promise<void>,
  cancelSignal: AbortSignal,
  page: PageContext,
): Promise<void> => {
  // A page already fetched is still stored during a shutdown; discarding it here would
  // waste the request and make the resume fetch the same URL again.
  if (cancelSignal.aborted) throw new NonRetryableError('job_no_longer_running');
  if ((await getInternalJobStatus(runtime.db, jobId)) !== 'running') {
    job.discard();
    throw new NonRetryableError('job_no_longer_running');
  }
  await guardTarget(request.loadedUrl || request.url);
  progress.processed += 1;
  const sourceUrl = request.loadedUrl || request.url;
  const data = extractGenericData(html, sourceUrl);
  const provenance = Object.fromEntries(Object.keys(data).map((key) => [key, request.url]));
  // The partial answer is still stored: it is the best result so far, and a later rendered
  // fetch supersedes it in place rather than racing it.
  progress.records += await insertResult(
    runtime.db,
    jobId,
    request.url,
    urlHash(request.url),
    data,
    provenance,
    page.fetcher,
  );
  if (page.mayEscalate) {
    const verdict = detectRenderDependence(html, data);
    if (verdict.needsRendering) await page.onEscalate(request, verdict);
  }
  await job.updateProgress(progress);
};

/**
 * Apply the crawl policy for every host this job will touch. robots.txt `Crawl-delay` and
 * the operator-approved `domains` row both bound the shared token bucket, so the limit is
 * enforced across replicas instead of per crawler instance.
 */
const configureHostLimits = async (
  runtime: Runtime,
  limiter: HostRateLimiter,
  robots: RobotsCache,
  spec: JobSpec,
  seeds: string[],
): Promise<void> => {
  const hosts = [...new Set(seeds.map(hostOf))];
  const policies = new Map(
    (await getDomainPolicies(runtime.db, hosts)).map((policy) => [policy.host, policy]),
  );
  for (const seed of seeds) {
    const host = hostOf(seed);
    const declaredDelay = robots.peek(seed)?.crawlDelaySeconds;
    const policy = policies.get(host);
    const intervals = [
      declaredDelay === undefined ? undefined : declaredDelay * 1_000,
      policy?.crawlDelayMs ?? undefined,
    ].filter((value): value is number => typeof value === 'number' && value > 0);
    limiter.configureHost(host, {
      ...(intervals.length > 0 ? { minIntervalMs: Math.max(...intervals) } : {}),
      maxRps: Math.min(spec.requestsPerSecond, policy?.maxRps ?? spec.requestsPerSecond),
    });
  }
};

export const processCrawlJob = async (
  runtime: Runtime,
  job: Job<JobSpec>,
  options: CrawlJobOptions = {},
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
  const workerId = options.workerId ?? workerIdentity();
  const resolveTarget = createCrawlTargetResolver();
  const guardTarget = async (rawUrl: string): Promise<void> => {
    await resolveTarget(rawUrl);
  };
  const robots = createRobotsCache({ resolveTarget });
  const limiter = createHostRateLimiter({
    redis: runtime.redis,
    defaultRps: spec.requestsPerSecond,
  });
  const routedPages = new WeakSet<object>();
  if (!(await markJobRunning(runtime.db, jobId))) {
    job.discard();
    throw new NonRetryableError('job_not_runnable');
  }
  const roots = spec.startUrls.map((url) => new URL(url).hostname);

  // Cancellation reaches the worker over Redis and is confirmed by a database poll, so a
  // running crawl stops fetching promptly instead of only at the next request boundary.
  const cancellation: CancellationWatch = await watchJobCancellation(runtime, jobId, {
    ...(options.cancelPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.cancelPollIntervalMs }),
  });
  // Only a cancellation aborts work already in flight. A shutdown stops the crawler from
  // dispatching anything new (`crawler.stop()`), then lets the requests that were already
  // issued finish and be recorded, so a resume neither refetches nor loses them.
  const cancelSignal = cancellation.signal;

  // `auto` starts on the HTTP worker and is rendered only once escalated onto the browser
  // queue, which is where the container has the shared memory a browser needs.
  const kind: CrawlWorkerKind =
    options.kind ?? (spec.browser === 'playwright' ? 'browser' : 'http');
  const useBrowser = spec.browser === 'playwright' || kind === 'browser';
  const mayEscalate = spec.browser === 'auto' && kind === 'http';
  const escalated = new Set<string>();

  // No local storage: the frontier lives in PostgreSQL and Crawlee keeps only its own
  // statistics, which stay in memory.
  const crawlConfiguration = new Configuration({ purgeOnStart: false, persistStorage: false });
  const frontier = new PostgresFrontier({
    db: runtime.db,
    jobId,
    workerId,
    maxRequests: spec.maxPages,
    // The HTTP pass cannot satisfy a row that owes a rendered fetch, so it never claims
    // one; that is what lets it finish and hand the job over.
    fetchers: useBrowser ? ['any', 'browser'] : ['any'],
  });
  // Crawlee validates crawler options with an exact shape that omits `requestManager`.
  // A bare `requestQueue` is accepted, and `initializeRequestManager` then uses it as the
  // request manager directly, which is exactly the seam this frontier needs.
  const frontierAsQueue = frontier as unknown as RequestProvider;
  let pinnedProxy: PinnedCrawlProxy | undefined;
  let crawler: CheerioCrawler | PlaywrightCrawler | undefined;

  const onCancelled = (): void => {
    log('info', 'crawl_cancelled', { jobId, reason: cancellation.reason() ?? 'cancelled' });
    void crawler?.autoscaledPool?.abort();
  };
  const onShutdown = (): void => {
    log('info', 'crawl_interrupted', { jobId, workerId });
    // Graceful: stop claiming new requests and let in-flight ones settle.
    crawler?.stop('worker_shutdown');
  };
  cancellation.signal.addEventListener('abort', onCancelled, { once: true });
  options.shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

  const recordOutcome = async (host: string, status: number | undefined): Promise<void> => {
    if (isThrottlingStatus(status)) return;
    if (status !== undefined && status >= 500) return;
    await limiter.recordSuccess(host);
  };

  const commonOptions = {
    maxRequestsPerCrawl: spec.maxPages,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: useBrowser ? browserConcurrency() : httpConcurrency(),
    // The shared per-host token bucket governs pacing; a per-crawler delay would not
    // constrain other replicas fetching the same host.
    sameDomainDelaySecs: 0,
    errorHandler: async ({ request }: { request: Request }, error: Error) => {
      if (error instanceof HostRateLimitError) return;
      await limiter.recordFailure(hostOf(request.url), {});
    },
    failedRequestHandler: async ({ request }: { request: Request }, error: Error) => {
      progress.failed += 1;
      await job.updateProgress(progress);
      await markFrontierFailed(runtime.db, jobId, request.uniqueKey, errorMessage(error));
      log('warn', 'request_failed', { jobId, url: safeLogUrl(request.url) });
    },
  };

  let interrupted = false;
  let handedOff = false;
  try {
    await Promise.all(spec.startUrls.map((url) => guardTarget(url)));
    // Robots policies are cached before the frontier is seeded, so no disallowed URL is
    // ever enqueued and the declared crawl-delay can bound the per-host request rate.
    await Promise.all(
      [...new Set(spec.startUrls.flatMap(robotsWarmupOrigins))].map((origin) =>
        robots.policyFor(origin),
      ),
    );
    const permittedSeeds = spec.startUrls.filter((url) => robots.isAllowedCached(url));
    if (permittedSeeds.length < spec.startUrls.length) {
      log('warn', 'robots_seeds_disallowed', {
        jobId,
        disallowed: spec.startUrls.length - permittedSeeds.length,
      });
    }
    const declaredSitemaps = robots.sitemaps();
    if (declaredSitemaps.length > 0) {
      // Sitemap-driven discovery is scheduled for M7; M4 only records the declaration.
      log('info', 'robots_sitemaps_declared', { jobId, count: declaredSitemaps.length });
    }
    if (permittedSeeds.length === 0) {
      job.discard();
      throw new NonRetryableError('robots_disallowed_all_seeds');
    }
    await configureHostLimits(runtime, limiter, robots, spec, permittedSeeds);

    // Resume rather than restart: seeds already present in the frontier are not re-added,
    // and work handled by a previous attempt is not handed out again.
    await frontier.initialize();
    await frontier.addRequestsBatched(
      permittedSeeds.map((url) => ({ url: canonicalizeUrl(url), userData: { depth: 0 } })),
    );

    const onEscalate = async (
      request: Request,
      verdict: ReturnType<typeof detectRenderDependence>,
    ): Promise<void> => {
      if (!(await escalateFrontierRequest(runtime.db, jobId, request.uniqueKey))) return;
      escalated.add(request.uniqueKey);
      frontier.markEscalated(request.uniqueKey);
      await recordEscalation(runtime.db, jobId, {
        url: safeLogUrl(request.url),
        reason: verdict.reason,
        signals: { ...verdict.signals },
      });
      log('info', 'crawl_page_escalated', {
        jobId,
        url: safeLogUrl(request.url),
        reason: verdict.reason,
      });
    };
    const pageContext: PageContext = {
      fetcher: useBrowser ? 'browser' : 'http',
      mayEscalate,
      onEscalate,
    };

    const guardNavigation = async (request: Request): Promise<void> => {
      if (cancelSignal.aborted) throw new NonRetryableError('job_no_longer_running');
      if ((await getInternalJobStatus(runtime.db, jobId)) !== 'running') {
        job.discard();
        throw new NonRetryableError('job_no_longer_running');
      }
      await guardTarget(request.url);
      // Authoritative check: this path can fetch, so it refreshes a policy that expired
      // mid-crawl and covers any origin a redirect or discovery produced.
      const policy = await robots.policyFor(request.url);
      if (!policy.isAllowed(request.url)) {
        throw new NonRetryableError('robots_disallowed');
      }
      await limiter.acquire(hostOf(request.url), cancelSignal);
    };

    if (useBrowser) {
      pinnedProxy = await createPinnedCrawlProxy(resolveTarget);
      crawler = new PlaywrightCrawler(
        {
          ...commonOptions,
          requestQueue: frontierAsQueue,
          preNavigationHooks: [
            async ({ request, page }) => {
              await guardNavigation(request);
              if (routedPages.has(page)) return;
              routedPages.add(page);
              // Every page, popup, iframe, and WebSocket remains confined to
              // the browser-wide pinned proxy. This route is a second policy
              // check; continue() cannot bypass the proxy's validated address.
              await page.route('**/*', async (route) => {
                if (cancelSignal.aborted) return route.abort('blockedbyclient');
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
          postNavigationHooks: [
            async ({ request, response }) => {
              const status = response?.status();
              if (isThrottlingStatus(status)) {
                await limiter.recordFailure(hostOf(request.url), {
                  ...(status === undefined ? {} : { statusCode: status }),
                  retryAfterMs: parseRetryAfter(response?.headers()['retry-after']),
                });
                return;
              }
              await recordOutcome(hostOf(request.url), status);
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
            await processPage(
              runtime,
              job,
              jobId,
              context.request,
              html,
              progress,
              guardTarget,
              cancelSignal,
              pageContext,
            );
            if (depth < spec.maxDepth && spec.mode !== 'single') {
              await context.enqueueLinks({
                strategy: 'same-hostname',
                transformRequestFunction: (request) =>
                  transformDiscoveredRequest(request, roots, spec, depth, robots, jobId),
              });
            }
          },
        },
        crawlConfiguration,
      );
      await crawler.run();
    } else {
      crawler = new CheerioCrawler(
        {
          ...commonOptions,
          requestQueue: frontierAsQueue,
          preNavigationHooks: [
            async ({ request }, gotOptions) => {
              await guardNavigation(request);
              gotOptions.dnsLookup = await createPinnedCrawlLookup(request.url, resolveTarget);
              gotOptions.maxRedirects = 5;
              // Aborting the signal tears down an in-flight fetch instead of leaving it
              // to run to the request-handler timeout after a cancellation.
              gotOptions.signal = cancelSignal;
              gotOptions.followRedirect = (response) => {
                const location = response.headers.location;
                if (!location) return false;
                const target = validateCrawlRedirectTarget(location, response.url);
                // This callback is synchronous and cannot fetch robots.txt, so an origin
                // with no loaded policy fails closed rather than being followed on trust.
                // Seed hosts are warmed on both schemes, so the ordinary HTTP-to-HTTPS
                // upgrade is covered; anything further afield is refused deliberately.
                if (!robots.isKnown(target)) {
                  log('warn', 'robots_redirect_origin_unknown', {
                    jobId,
                    url: safeLogUrl(target),
                  });
                  return false;
                }
                return robots.peek(target)?.isAllowed(target) ?? false;
              };
            },
          ],
          postNavigationHooks: [
            async ({ request, response }) => {
              const status = response?.statusCode;
              if (isThrottlingStatus(status)) {
                await limiter.recordFailure(hostOf(request.url), {
                  ...(status === undefined ? {} : { statusCode: status }),
                  retryAfterMs: parseRetryAfter(response?.headers['retry-after']),
                });
                return;
              }
              await recordOutcome(hostOf(request.url), status);
            },
          ],
          requestHandler: async (context) => {
            const depth = requestDepth(context.request);
            const html = Buffer.isBuffer(context.body)
              ? context.body.toString('utf8')
              : String(context.body);
            await processPage(
              runtime,
              job,
              jobId,
              context.request,
              html,
              progress,
              guardTarget,
              cancelSignal,
              pageContext,
            );
            if (depth < spec.maxDepth && spec.mode !== 'single') {
              await context.enqueueLinks({
                strategy: 'same-hostname',
                transformRequestFunction: (request) =>
                  transformDiscoveredRequest(request, roots, spec, depth, robots, jobId),
              });
            }
          },
        },
        crawlConfiguration,
      );
      await crawler.run();
    }

    if (cancellation.signal.aborted) {
      job.discard();
      throw new NonRetryableError('job_no_longer_running');
    }
    if (options.shutdownSignal?.aborted) {
      interrupted = true;
      throw new CrawlInterruptedError();
    }

    const owed = mayEscalate ? await countEscalatedFrontierRequests(runtime.db, jobId) : 0;
    if (owed > 0) {
      // The frontier and every result so far are kept; the browser pass resumes from them
      // and refetches only the rows that owe a rendered answer.
      handedOff = true;
      await crawlQueueForKind(runtime, 'browser').add('crawl', spec, { jobId });
      log('info', 'crawl_handed_to_browser', { jobId, escalated: owed });
      throw new CrawlEscalatedError(owed);
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
    if (error instanceof CrawlInterruptedError || error instanceof CrawlEscalatedError) throw error;
    const configuredAttempts = Math.max(1, Number(job.opts.attempts ?? 1));
    const finalAttempt = job.attemptsMade + 1 >= configuredAttempts;
    if (finalAttempt || error instanceof NonRetryableError) {
      await markJobFailed(runtime.db, jobId, errorMessage(error));
    }
    throw error;
  } finally {
    cancellation.signal.removeEventListener('abort', onCancelled);
    options.shutdownSignal?.removeEventListener('abort', onShutdown);
    await cancellation.stop();
    await pinnedProxy?.close();
    if (interrupted || handedOff) {
      // Hand claims back so the retry, on this replica or another, resumes immediately
      // from the durable frontier instead of waiting out the visibility timeout.
      const released = await frontier.releaseOutstandingClaims().catch(() => 0);
      log('info', 'frontier_claims_released', { jobId, workerId, released });
    } else {
      await deleteFrontier(runtime.db, jobId).catch((error: unknown) => {
        log('warn', 'frontier_cleanup_failed', { jobId, error: errorMessage(error) });
      });
    }
  }
};

/**
 * Periodically return claims whose visibility timeout expired. This is what recovers work
 * from a replica that was killed outright rather than shut down.
 */
export const startFrontierRecovery = (
  runtime: Runtime,
  intervalSeconds = frontierSweepSeconds(),
): (() => void) => {
  const timer = setInterval(() => {
    void releaseExpiredFrontierClaims(runtime.db, frontierVisibilitySeconds())
      .then((released) => {
        if (released > 0) log('info', 'frontier_claims_recovered', { released });
      })
      .catch((error: unknown) => {
        log('warn', 'frontier_recovery_failed', { error: errorMessage(error) });
      });
  }, intervalSeconds * 1_000);
  timer.unref();
  return () => clearInterval(timer);
};

export const createCrawlWorker = (
  runtime: Runtime,
  kind: CrawlWorkerKind,
  shutdown?: ShutdownCoordinator,
): Worker<JobSpec> => {
  const workerId = workerIdentity();
  const coordinator = shutdown ?? createShutdownCoordinator({ signals: [] });
  const worker = new Worker<JobSpec>(
    crawlQueueForKind(runtime, kind).name,
    (job) => processCrawlJob(runtime, job, { workerId, kind, shutdownSignal: coordinator.signal }),
    {
      connection: runtime.redisConnection,
      concurrency: jobConcurrency(),
    },
  );
  const stopRecovery = startFrontierRecovery(runtime);

  coordinator.onShutdown('stop-claiming-jobs', async () => {
    stopRecovery();
    // Stop taking new jobs immediately; in-flight jobs observe the shutdown signal and
    // checkpoint their frontier claims.
    await worker.close();
  });
  coordinator.onShutdown('release-frontier-claims', async () => {
    const released = await releaseWorkerFrontierClaims(runtime.db, workerId);
    log('info', 'frontier_worker_claims_released', { workerId, released });
  });

  return worker;
};
