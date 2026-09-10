import crypto from 'node:crypto';
import fs from 'node:fs';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHostRateLimiter } from '../../src/frontier/rate-limit.js';
import { PostgresFrontier } from '../../src/frontier/request-manager.js';
import { closeRuntime, createRuntime } from '../../src/runtime.js';
import { crawlQueueForKind } from '../../src/queues/crawl.js';
import {
  addFrontierRequests,
  claimFrontierRequests,
  deleteFrontier,
  frontierCounts,
  releaseExpiredFrontierClaims,
  releaseWorkerFrontierClaims,
} from '../../src/storage/postgres/frontier.js';
import { migrateDatabase } from '../../src/storage/postgres/migrate.js';
import {
  cancelJob,
  createJob,
  getInternalJobStatus,
} from '../../src/storage/postgres/repository.js';
import type { JobSpec } from '../../src/config/schema.js';
import type { Runtime } from '../../src/types.js';
import { publishJobCancellation } from '../../src/workers/cancellation.js';
import { createCrawlWorker } from '../../src/workers/crawl.js';
import { createShutdownCoordinator } from '../../src/workers/shutdown.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.js';

const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const REDIS_IMAGE =
  'redis:7.4-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2';
const TENANT = 'fixture-tenant';
const CLIENT = 'fixture-client';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hashOf = (url: string): string => crypto.createHash('sha256').update(url).digest('hex');

describe('durable frontier, cancellation, and resumable claims', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let fixture: FixtureSite;
  let runtime: Runtime;
  /** Requests the fixture site served, keyed by path. */
  let served: Map<string, number>;

  const spec = (overrides: Partial<JobSpec> = {}): JobSpec =>
    ({
      startUrls: [`${fixture.baseUrl}/chain/1`],
      mode: 'domain',
      maxPages: 40,
      maxDepth: 10,
      browser: 'http',
      extract: [],
      includePatterns: [],
      excludePatterns: [],
      requestsPerSecond: 20,
      ...overrides,
    }) as JobSpec;

  const submitJob = async (jobSpec: JobSpec, key: string): Promise<string> => {
    const jobId = crypto.randomUUID();
    await createJob(
      runtime.db,
      jobId,
      jobSpec,
      key,
      crypto.createHash('sha256').update(JSON.stringify(jobSpec)).digest('hex'),
      key,
      TENANT,
      CLIENT,
    );
    return jobId;
  };

  beforeAll(async () => {
    [postgres, redis, fixture] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('crawler')
        .withUsername('crawler')
        .withPassword('fixture-only-not-production')
        .start(),
      new RedisContainer(REDIS_IMAGE).start(),
      startFixtureSite(),
    ]);
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_HOST = redis.getHost();
    process.env.REDIS_PORT = String(redis.getPort());
    process.env.MIDDLEWARE_BASE_URL = '';
    process.env.HTTP_CONCURRENCY = '1';
    process.env.JOB_CONCURRENCY = '1';
    process.env.KYQRA_ALLOW_TEST_TARGETS = 'true';
    await migrateDatabase(postgres.getConnectionUri(), 'up');
    runtime = createRuntime();

    // A chain of deliberately slow pages: each links to the next, so a crawl of it keeps
    // fetching long enough to observe a cancellation or an interruption mid-flight.
    served = new Map();
    fixture.app.get('/chain/:step', async (request, response) => {
      const path = request.path;
      served.set(path, (served.get(path) ?? 0) + 1);
      const step = Number(request.params.step);
      await sleep(250);
      const next =
        step < 40
          ? [1, 2, 3].map((child) => `<a href="/chain/${step * 3 + child}">n</a>`).join('')
          : '';
      response
        .type('html')
        .send(
          `<!doctype html><html><head><title>Chain ${step}</title>` +
            `<meta property="og:site_name" content="Chain ${step}"></head>` +
            `<body>${next}</body></html>`,
        );
    });
  });

  afterAll(async () => {
    if (runtime) await closeRuntime(runtime);
    await fixture?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it('claims each URL exactly once and recovers claims that outlive their visibility', async () => {
    const jobId = await submitJob(spec(), 'frontier-store');
    const urls = ['https://a.test/1', 'https://a.test/2', 'https://a.test/3'];
    const entries = urls.map((url, index) => ({
      url,
      urlHash: hashOf(url),
      host: 'a.test',
      depth: index,
    }));

    const first = await addFrontierRequests(runtime.db, jobId, entries);
    expect(first.added).toHaveLength(3);
    // The same URLs offered again are recognised, not duplicated.
    const second = await addFrontierRequests(runtime.db, jobId, entries);
    expect(second.added).toHaveLength(0);
    expect(second.existing).toHaveLength(3);
    expect(await frontierCounts(runtime.db, jobId)).toMatchObject({ pending: 3, claimed: 0 });

    // Two workers claiming concurrently take disjoint work.
    const [alpha, beta] = await Promise.all([
      claimFrontierRequests(runtime.db, jobId, 'worker-alpha', 2),
      claimFrontierRequests(runtime.db, jobId, 'worker-beta', 2),
    ]);
    const claimedHashes = [...alpha, ...beta].map((row) => row.urlHash);
    expect(claimedHashes).toHaveLength(3);
    expect(new Set(claimedHashes).size).toBe(3);
    expect(await frontierCounts(runtime.db, jobId)).toMatchObject({ pending: 0, claimed: 3 });

    // A claim younger than the visibility window is left alone.
    expect(await releaseExpiredFrontierClaims(runtime.db, 3_600)).toBe(0);

    // Releasing one worker's claims returns only that worker's rows.
    const releasedForAlpha = await releaseWorkerFrontierClaims(runtime.db, 'worker-alpha');
    expect(releasedForAlpha).toBe(alpha.length);
    expect(await frontierCounts(runtime.db, jobId)).toMatchObject({
      pending: alpha.length,
      claimed: beta.length,
    });

    // An abandoned claim comes back once its visibility timeout passes.
    await sleep(1_100);
    expect(await releaseExpiredFrontierClaims(runtime.db, 1)).toBe(beta.length);
    expect(await frontierCounts(runtime.db, jobId)).toMatchObject({ pending: 3, claimed: 0 });

    expect(await deleteFrontier(runtime.db, jobId)).toBe(3);
  });

  it('refuses to grow the frontier past the job page budget', async () => {
    const jobId = await submitJob(spec({ maxPages: 2 }), 'frontier-budget');
    const frontier = new PostgresFrontier({
      db: runtime.db,
      jobId,
      workerId: 'worker-budget',
      maxRequests: 2,
    });
    await frontier.initialize();

    const result = await frontier.addRequestsBatched(
      ['https://b.test/1', 'https://b.test/2', 'https://b.test/3', 'https://b.test/4'].map(
        (url) => ({ url, userData: { depth: 0 } }),
      ),
    );
    expect(result.addedRequests).toHaveLength(2);
    expect(result.requestsOverLimit).toHaveLength(2);
    expect(await frontierCounts(runtime.db, jobId)).toMatchObject({ pending: 2 });
    await deleteFrontier(runtime.db, jobId);
  });

  it('stops all fetching within five seconds of a cancellation', async () => {
    const jobId = await submitJob(spec(), 'frontier-cancel');
    const coordinator = createShutdownCoordinator({ signals: [] });
    const worker = createCrawlWorker(runtime, 'http', coordinator);
    await worker.waitUntilReady();
    await crawlQueueForKind(runtime, 'http').add('crawl', spec(), { jobId });

    // Let the crawl get properly underway before cancelling it.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && served.size < 3) await sleep(100);
    expect(served.size).toBeGreaterThanOrEqual(3);

    await cancelJob(runtime.db, jobId, TENANT);
    await publishJobCancellation(runtime, jobId);
    const cancelledAt = Date.now();
    const servedAtCancel = served.size;

    // Everything fetched after the cancellation must land in a short window.
    await sleep(5_000);
    const servedAfterGrace = served.size;
    await sleep(3_000);
    expect(served.size).toBe(servedAfterGrace);
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(5_000);
    // A crawl that ignored the cancellation would have fetched the whole 30-page chain.
    expect(servedAfterGrace).toBeLessThan(servedAtCancel + 15);
    expect(await getInternalJobStatus(runtime.db, jobId)).toBe('cancelled');

    await coordinator.shutdown('test');
    await deleteFrontier(runtime.db, jobId);
  }, 90_000);

  it('checkpoints an interrupted crawl and resumes it without loss or duplication', async () => {
    served.clear();
    const jobSpec = spec({ startUrls: [`${fixture.baseUrl}/chain/1`], maxPages: 8, maxDepth: 8 });
    const jobId = await submitJob(jobSpec, 'frontier-resume');

    const first = createShutdownCoordinator({ signals: [] });
    const firstWorker = createCrawlWorker(runtime, 'http', first);
    await firstWorker.waitUntilReady();
    await crawlQueueForKind(runtime, 'http').add('crawl', jobSpec, { jobId });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && served.size < 2) await sleep(100);
    expect(served.size).toBeGreaterThanOrEqual(2);

    // A deploy: SIGTERM equivalent. The worker stops claiming, the in-flight crawl
    // checkpoints, and its claims go back to the pending pool.
    await first.shutdown('SIGTERM');
    const afterShutdown = await frontierCounts(runtime.db, jobId);
    expect(afterShutdown.claimed).toBe(0);
    expect(afterShutdown.pending + afterShutdown.handled).toBeGreaterThan(0);
    // Work already done survives the interruption instead of being crawled again.
    expect(afterShutdown.handled).toBeGreaterThan(0);
    expect(await getInternalJobStatus(runtime.db, jobId)).toBe('running');

    // A replacement worker picks the job up from the durable frontier.
    const second = createShutdownCoordinator({ signals: [] });
    const secondWorker = createCrawlWorker(runtime, 'http', second);
    await secondWorker.waitUntilReady();

    const completionDeadline = Date.now() + 60_000;
    let status = await getInternalJobStatus(runtime.db, jobId);
    while (Date.now() < completionDeadline && status === 'running') {
      await sleep(250);
      status = await getInternalJobStatus(runtime.db, jobId);
    }
    expect(status).toBe('completed');

    // No URL was fetched twice across the interruption.
    const refetched = [...served.entries()].filter(([, count]) => count > 1);
    expect(refetched).toEqual([]);
    const stored = await runtime.db.query<{ total: string; distinct: string }>(
      'select count(*)::text as total, count(distinct url_hash)::text as distinct from results where job_id=$1',
      [jobId],
    );
    expect(stored.rows[0]?.total).toBe(stored.rows[0]?.distinct);

    await second.shutdown('test');
  }, 120_000);

  it('paces every replica through one shared bucket and honors Retry-After', async () => {
    const limiter = createHostRateLimiter({ redis: runtime.redis, defaultRps: 2, burst: 1 });
    limiter.configureHost('paced.test', { maxRps: 2 });

    const started = Date.now();
    // Concurrent callers stand for separate replicas sharing the same host budget.
    await Promise.all([
      limiter.acquire('paced.test'),
      limiter.acquire('paced.test'),
      limiter.acquire('paced.test'),
    ]);
    const elapsed = Date.now() - started;
    // Two of the three must wait roughly half a second each at 2 requests per second.
    expect(elapsed).toBeGreaterThan(700);
    expect(elapsed).toBeLessThan(10_000);

    await limiter.recordFailure('throttled.test', { statusCode: 429, retryAfterMs: 900 });
    const cooldownStart = Date.now();
    await limiter.acquire('throttled.test');
    expect(Date.now() - cooldownStart).toBeGreaterThan(700);
  }, 60_000);

  it('keeps the frontier in PostgreSQL rather than on the worker filesystem', () => {
    // Crawlee's default storage client writes ./storage when it owns the request queue.
    expect(fs.existsSync('storage/request_queues')).toBe(false);
  });

  it('escalates a render-dependent page from the HTTP worker to the browser queue', async () => {
    // A single-page application shell: the server ships an empty mount point and a script.
    // Fetched over plain HTTP this yields no contact data, which `browser=auto` previously
    // reported as a successful, empty crawl.
    fixture.app.get('/spa', (_request, response) => {
      response
        .type('html')
        .send(
          '<!doctype html><html><head><title>Ridgeway App</title></head>' +
            '<body><div id="root"></div><script src="/static/bundle.js"></script></body></html>',
        );
    });

    const jobSpec = spec({
      startUrls: [`${fixture.baseUrl}/spa`],
      mode: 'single',
      maxPages: 1,
      maxDepth: 0,
      browser: 'auto',
    });
    const jobId = await submitJob(jobSpec, 'adaptive-escalation');

    const coordinator = createShutdownCoordinator({ signals: [] });
    const worker = createCrawlWorker(runtime, 'http', coordinator);
    await worker.waitUntilReady();
    // `browser=auto` starts on the HTTP queue, exactly as it did before M5.
    await crawlQueueForKind(runtime, 'http').add('crawl', jobSpec, { jobId });

    const deadline = Date.now() + 30_000;
    let escalations = 0;
    while (Date.now() < deadline && escalations === 0) {
      const events = await runtime.db.query<{ total: string }>(
        "select count(*)::text as total from job_events where job_id=$1 and event_type='job.escalated'",
        [jobId],
      );
      escalations = Number(events.rows[0]?.total ?? 0);
      if (escalations === 0) await sleep(200);
    }
    expect(escalations).toBe(1);

    // The evidence says which signal decided it, not merely that something happened.
    const evidence = await runtime.db.query<{ payload: { reason: string; url: string } }>(
      "select payload from job_events where job_id=$1 and event_type='job.escalated'",
      [jobId],
    );
    expect(evidence.rows[0]?.payload.reason).toBe('empty_mount_point');
    expect(evidence.rows[0]?.payload.url).toContain('/spa');

    // The row owes a rendered fetch and is queued again rather than left handled.
    const row = await runtime.db.query<{ state: string; fetcher: string }>(
      'select state,fetcher from frontier where job_id=$1',
      [jobId],
    );
    expect(row.rows[0]).toMatchObject({ state: 'pending', fetcher: 'browser' });

    // The partial HTTP answer is kept and attributed, so nothing is lost in the handover.
    const stored = await runtime.db.query<{ fetcher: string }>(
      'select fetcher from results where job_id=$1',
      [jobId],
    );
    expect(stored.rows[0]?.fetcher).toBe('http');

    // The job moved to the browser queue and is still runnable — an escalation is not a
    // failure, and must not be recorded as one.
    const handedOff = await crawlQueueForKind(runtime, 'browser').getJob(jobId);
    expect(handedOff).toBeDefined();
    expect(await getInternalJobStatus(runtime.db, jobId)).toBe('running');

    await coordinator.shutdown('test');
    await crawlQueueForKind(runtime, 'browser')
      .getJob(jobId)
      .then((queued) => queued?.remove())
      .catch(() => undefined);
    await deleteFrontier(runtime.db, jobId);
  }, 90_000);

  it('leaves a server-rendered page on the HTTP fetcher', async () => {
    fixture.app.get('/plain', (_request, response) => {
      response
        .type('html')
        .send(
          '<!doctype html><html><head><title>Ridgeway Plumbing</title>' +
            '<meta property="og:site_name" content="Ridgeway Plumbing"></head><body>' +
            '<h1>Ridgeway Plumbing</h1><p>Call +1 (555) 123-4567 or email hi@ridgeway.test.</p>' +
            '<address>18 Mill Lane</address></body></html>',
        );
    });

    const jobSpec = spec({
      startUrls: [`${fixture.baseUrl}/plain`],
      mode: 'single',
      maxPages: 1,
      maxDepth: 0,
      browser: 'auto',
    });
    const jobId = await submitJob(jobSpec, 'adaptive-no-escalation');

    const coordinator = createShutdownCoordinator({ signals: [] });
    const worker = createCrawlWorker(runtime, 'http', coordinator);
    await worker.waitUntilReady();
    await crawlQueueForKind(runtime, 'http').add('crawl', jobSpec, { jobId });

    const deadline = Date.now() + 30_000;
    let status = await getInternalJobStatus(runtime.db, jobId);
    while (Date.now() < deadline && status === 'queued') {
      await sleep(200);
      status = await getInternalJobStatus(runtime.db, jobId);
    }
    while (Date.now() < deadline && status === 'running') {
      await sleep(200);
      status = await getInternalJobStatus(runtime.db, jobId);
    }
    // A page that delivered its content completes on HTTP, with no browser involved.
    expect(status).toBe('completed');

    const escalated = await runtime.db.query<{ total: string }>(
      "select count(*)::text as total from job_events where job_id=$1 and event_type='job.escalated'",
      [jobId],
    );
    expect(escalated.rows[0]?.total).toBe('0');

    const stored = await runtime.db.query<{ fetcher: string }>(
      'select fetcher from results where job_id=$1',
      [jobId],
    );
    expect(stored.rows[0]?.fetcher).toBe('http');

    await coordinator.shutdown('test');
  }, 90_000);
});
