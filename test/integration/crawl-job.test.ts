import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import request, { type SuperTest, type Test } from 'supertest';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApi } from '../../src/api/app.js';
import { removeCrawlJob } from '../../src/queues/crawl.js';
import { closeRuntime, createRuntime } from '../../src/runtime.js';
import type { JobSpec } from '../../src/config/schema.js';
import { migrateDatabase } from '../../src/storage/postgres/migrate.js';
import { insertResult } from '../../src/storage/postgres/repository.js';
import type { CallbackJobData, Runtime } from '../../src/types.js';
import { createCrawlWorker } from '../../src/workers/crawl.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.js';

const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const REDIS_IMAGE =
  'redis:7.4-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2';
const API_TOKEN = 'fixture-api-key-not-production';
const READONLY_TOKEN = 'fixture-readonly-key-not-production';

const waitForCompleted = async (client: SuperTest<Test>, jobId: string): Promise<void> => {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await client
      .get(`/api/v1/jobs/${jobId}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    if (response.body.status === 'completed') return;
    if (response.body.status === 'failed') {
      throw new Error(`crawl failed: ${String(response.body.error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('crawl_completion_timeout');
};

describe('HTTP job submission through real Redis and Postgres', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let fixture: FixtureSite;
  let runtime: Runtime;
  let app: FastifyInstance;
  let crawlWorker: Worker<JobSpec>;
  let client: SuperTest<Test>;
  let fixtureDirectory: string;

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
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kyqra-m1-'));
    process.env.CRAWLEE_STORAGE_DIR = path.join(fixtureDirectory, 'crawlee-storage');
    const principalPath = path.join(fixtureDirectory, 'principals.json');
    fs.writeFileSync(
      principalPath,
      JSON.stringify({
        principals: [
          {
            key_sha256: crypto.createHash('sha256').update(API_TOKEN).digest('hex'),
            tenant_id: 'fixture-tenant',
            client_id: 'fixture-client',
            roles: ['operations'],
            enabled: true,
          },
          {
            key_sha256: crypto.createHash('sha256').update(READONLY_TOKEN).digest('hex'),
            tenant_id: 'fixture-tenant',
            client_id: 'fixture-readonly',
            roles: [],
            enabled: true,
          },
        ],
      }),
    );
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_HOST = redis.getHost();
    process.env.REDIS_PORT = String(redis.getPort());
    process.env.KYQRA_SERVICE_PRINCIPALS_FILE = principalPath;
    process.env.MIDDLEWARE_BASE_URL = '';
    process.env.KYQRA_ALLOW_TEST_TARGETS = 'true';
    process.env.HTTP_CONCURRENCY = '2';
    await migrateDatabase(postgres.getConnectionUri(), 'up');
    runtime = createRuntime();
    app = await buildApi(runtime);
    await app.ready();
    crawlWorker = createCrawlWorker(runtime, 'http');
    await crawlWorker.waitUntilReady();
    client = request(app.server);
  });

  afterAll(async () => {
    await app?.close();
    await crawlWorker?.close(true);
    if (runtime) await closeRuntime(runtime);
    await fixture?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
    if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it('submits over HTTP, crawls the fixture, and persists tenant-scoped results', async () => {
    expect((await client.get('/')).status).toBe(200);
    expect((await client.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await client.get('/readyz')).body).toEqual({
      status: 'ok',
      redis: 'ok',
      postgres: 'ok',
    });
    expect((await client.get('/api/v1/stats')).status).toBe(401);
    expect((await client.get('/api/v1/stats').set('Authorization', API_TOKEN)).status).toBe(401);
    expect(
      (await client.get('/api/v1/me').set('Authorization', `bearer ${API_TOKEN}`)).status,
    ).toBe(200);
    expect(
      (await client.get('/api/v1/stats').set('Authorization', `Bearer ${READONLY_TOKEN}`)).status,
    ).toBe(403);
    expect(
      (
        await client
          .get('/api/v1/stats')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .set('X-Tenant-Id', 'wrong-tenant')
      ).status,
    ).toBe(403);
    expect(
      (
        await client
          .post('/api/v1/jobs')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .set('Idempotency-Key', 'invalid-job')
          .set('X-Correlation-Id', 'invalid-job')
          .send({ startUrls: [] })
      ).status,
    ).toBe(400);
    expect(
      (
        await client
          .post('/api/v1/jobs')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .send({ startUrls: [`${fixture.baseUrl}/static`] })
      ).body.error,
    ).toBe('idempotency_and_correlation_required');
    expect(
      (
        await client
          .post('/api/v1/jobs')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .set('Idempotency-Key', 'unsafe-callback')
          .set('X-Correlation-Id', 'unsafe-callback')
          .send({
            startUrls: [`${fixture.baseUrl}/static`],
            callbackUrl: 'https://unapproved.example.test/events',
          })
      ).body.error,
    ).toBe('callback_not_allowed');

    const enqueueFailure = vi
      .spyOn(runtime.httpCrawlQueue, 'add')
      .mockRejectedValue(new Error('fixture_enqueue_failure'));
    const failedSubmission = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-enqueue-failure')
      .set('X-Correlation-Id', 'fixture-enqueue-failure-correlation')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(failedSubmission.status).toBe(503);
    expect(failedSubmission.body).toMatchObject({
      status: 'failed',
      duplicate: false,
      reconciliation_required: true,
    });
    const failedReplay = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-enqueue-failure')
      .set('X-Correlation-Id', 'fixture-enqueue-failure-correlation')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(failedReplay.status).toBe(503);
    expect(failedReplay.body).toMatchObject({
      id: failedSubmission.body.id,
      status: 'failed',
      duplicate: true,
      reconciliation_required: true,
    });
    const failedReconciliation = await client
      .post(`/api/v1/operations/${String(failedSubmission.body.id)}/reconcile`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-enqueue-reconcile')
      .set('X-Correlation-Id', 'fixture-enqueue-reconcile');
    expect(failedReconciliation.status).toBe(500);
    const stableFailedReplay = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-enqueue-failure')
      .set('X-Correlation-Id', 'fixture-enqueue-failure-correlation')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(stableFailedReplay.status).toBe(503);
    expect(stableFailedReplay.body).toMatchObject({
      id: failedSubmission.body.id,
      status: 'failed',
      duplicate: true,
      reconciliation_required: true,
    });
    expect(enqueueFailure).toHaveBeenCalledTimes(2);
    enqueueFailure.mockRestore();

    const submission = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-static-1')
      .set('X-Correlation-Id', 'fixture-correlation-1')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(submission.status).toBe(202);
    expect(submission.body.status).toBe('queued');
    const jobId = String(submission.body.id);
    await waitForCompleted(client, jobId);

    expect(
      await insertResult(
        runtime.db,
        jobId,
        `${fixture.baseUrl}/late-result`,
        'late-result-after-completion',
        {
          business_name: 'Late result',
          website: '',
          description: '',
          phone: [],
          email: [],
          address: '',
          page_title: '',
          schema_org: [],
          source_url: `${fixture.baseUrl}/late-result`,
          crawl_timestamp: new Date(0).toISOString(),
        },
        {},
      ),
    ).toBe(0);

    const status = await client
      .get(`/api/v1/jobs/${jobId}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(status.body).toMatchObject({ id: jobId, status: 'completed' });

    const results = await client
      .get(`/api/v1/jobs/${jobId}/results`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(results.status).toBe(200);
    expect(results.body.correlation_id).toBe('fixture-correlation-1');
    expect(results.body.count).toBe(1);
    expect(results.body.results[0].data).toMatchObject({
      business_name: 'Fixture Industries',
      email: ['hello@fixture.test'],
      address: '100 Test Avenue',
      source_url: `${fixture.baseUrl}/static`,
    });
    const stored = await runtime.db.query<{ count: string }>(
      'select count(*)::text as count from results where job_id=$1',
      [jobId],
    );
    expect(stored.rows[0]?.count).toBe('1');
    const csv = await client
      .get(`/api/v1/jobs/${jobId}/results?format=csv`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Fixture Industries');

    const replay = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-static-1')
      .set('X-Correlation-Id', 'fixture-correlation-1')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: jobId, duplicate: true });

    const conflict = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-static-1')
      .set('X-Correlation-Id', 'fixture-correlation-1')
      .send({
        startUrls: [`${fixture.baseUrl}/json-ld`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('idempotency_conflict');

    const stats = await client.get('/api/v1/stats').set('Authorization', `Bearer ${API_TOKEN}`);
    expect(stats.status).toBe(200);
    expect(stats.body.workers).toEqual({ http: 2, browser: 3 });

    const jobs = await client.get('/api/v1/jobs').set('Authorization', `Bearer ${API_TOKEN}`);
    expect(jobs.status).toBe(200);
    expect(jobs.body.items.some(({ id }: { id: string }) => id === jobId)).toBe(true);
    const events = await client
      .get(`/api/v1/jobs/${jobId}/events`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(events.status).toBe(200);
    expect(events.body.items.map(({ status }: { status: string }) => status)).toEqual(
      expect.arrayContaining(['queued', 'running', 'completed']),
    );
    const operation = await client
      .get(`/api/v1/operations/${jobId}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(operation.body).toMatchObject({ operation_id: jobId, status: 'SUCCEEDED' });
    const callbackRecovery = await client
      .post(`/api/v1/operations/${jobId}/reconcile`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-callback-reconcile-1')
      .set('X-Correlation-Id', 'fixture-callback-reconcile-1');
    expect(callbackRecovery.status).toBe(202);
    expect(callbackRecovery.body).toMatchObject({
      operation_id: jobId,
      status: 'SUCCEEDED',
      callbacks_reconciled: true,
    });
    const resultRow = await runtime.db.query<{ id: string }>(
      'select id::text from results where job_id=$1 order by id limit 1',
      [jobId],
    );
    const callbackJobId = `kyqra-result-${jobId}-${resultRow.rows[0]?.id}`;
    const failingCallbackWorker = new Worker<CallbackJobData>(
      'callbacks',
      async () => {
        throw new Error('fixture_callback_failure');
      },
      { connection: runtime.redisConnection },
    );
    await failingCallbackWorker.waitUntilReady();
    await runtime.callbackQueue.add(
      'result',
      { jobId, url: 'http://10.40.0.1/api/v1/kyqra/results', payload: {} },
      { jobId: callbackJobId, attempts: 1 },
    );
    const callbackFailureDeadline = Date.now() + 5_000;
    while (
      Date.now() < callbackFailureDeadline &&
      (await runtime.callbackQueue.getJob(callbackJobId))?.failedReason !==
        'fixture_callback_failure'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await failingCallbackWorker.close();
    expect(await (await runtime.callbackQueue.getJob(callbackJobId))?.getState()).toBe('failed');
    process.env.MIDDLEWARE_BASE_URL = 'http://10.40.0.1';
    const revivedCallbacks = await client
      .post(`/api/v1/operations/${jobId}/reconcile`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-callback-reconcile-2')
      .set('X-Correlation-Id', 'fixture-callback-reconcile-2');
    expect(revivedCallbacks.status).toBe(202);
    expect(await (await runtime.callbackQueue.getJob(callbackJobId))?.getState()).toBe('waiting');
    for (const queuedId of [callbackJobId, `kyqra-progress-${jobId}`]) {
      await (await runtime.callbackQueue.getJob(queuedId))?.remove();
    }
    process.env.MIDDLEWARE_BASE_URL = '';
    expect(
      (await client.get('/metrics').set('Authorization', `Bearer ${READONLY_TOKEN}`)).status,
    ).toBe(403);
    expect((await client.get('/metrics').set('Authorization', `Bearer ${API_TOKEN}`)).status).toBe(
      200,
    );
    expect((await client.get('/openapi.json')).body.paths['/api/v1/jobs']).toBeDefined();

    const cancelled = await client
      .post(`/api/v1/jobs/${jobId}/cancel`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'terminal-cancel-1')
      .set('X-Correlation-Id', 'terminal-cancel-1');
    expect(cancelled.status).toBe(409);
    expect(cancelled.body).toEqual({ id: jobId, error: 'job_terminal' });
    const cancelledReplay = await client
      .post(`/api/v1/jobs/${jobId}/cancel`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'terminal-cancel-1')
      .set('X-Correlation-Id', 'terminal-cancel-1');
    expect(cancelledReplay.status).toBe(409);
    expect(cancelledReplay.body).toEqual(cancelled.body);

    const completedRetry = await client
      .post(`/api/v1/jobs/${jobId}/retry`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'terminal-cancel-1')
      .set('X-Correlation-Id', 'terminal-retry-1');
    expect(completedRetry.status).toBe(409);
    expect(completedRetry.body.error).toBe('job_not_retryable');

    const slowSubmission = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'slow-111')
      .set('X-Correlation-Id', 'fixture-slow-cancel-1')
      .send({
        startUrls: [`${fixture.baseUrl}/slow`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(slowSubmission.status).toBe(202);
    const slowJobId = String(slowSubmission.body.id);
    const cancelSlow = await client
      .post(`/api/v1/jobs/${slowJobId}/cancel`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-slow-cancel-command-1')
      .set('X-Correlation-Id', 'fixture-slow-cancel-command-1');
    expect(cancelSlow.status).toBe(200);
    expect(cancelSlow.body).toEqual({ id: slowJobId, status: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cancelledStatus = await client
      .get(`/api/v1/jobs/${slowJobId}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(cancelledStatus.body.status).toBe('cancelled');
    const cancelledResults = await client
      .get(`/api/v1/jobs/${slowJobId}/results`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(cancelledResults.body.count).toBe(0);
    const cancelledEvents = await client
      .get(`/api/v1/jobs/${slowJobId}/events`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(
      cancelledEvents.body.items.map(({ status }: { status: string }) => status),
    ).not.toContain('completed');

    const retryCancelled = await client
      .post(`/api/v1/jobs/${slowJobId}/retry`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-slow-retry-command-1')
      .set('X-Correlation-Id', 'fixture-slow-retry-command-1');
    expect(retryCancelled.status).toBe(202);
    await waitForCompleted(client, slowJobId);
    const retriedResults = await client
      .get(`/api/v1/jobs/${slowJobId}/results`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(retriedResults.body.count).toBe(1);

    await runtime.httpCrawlQueue.pause();
    const orphanSubmission = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'orphan-queued-submit-1')
      .set('X-Correlation-Id', 'orphan-queued-submit-1')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(orphanSubmission.status).toBe(202);
    const orphanJobId = String(orphanSubmission.body.id);
    await removeCrawlJob(runtime, orphanJobId);
    expect(await runtime.httpCrawlQueue.getJob(orphanJobId)).toBeUndefined();
    const orphanReconcile = await client
      .post(`/api/v1/operations/${orphanJobId}/reconcile`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'orphan-queued-reconcile-1')
      .set('X-Correlation-Id', 'orphan-queued-reconcile-1');
    expect(orphanReconcile.status).toBe(202);
    expect(orphanReconcile.body).toMatchObject({
      operation_id: orphanJobId,
      status: 'QUEUED',
      queue_entry_recreated: true,
    });
    expect(await runtime.httpCrawlQueue.getJob(orphanJobId)).toBeDefined();
    const raceSubmission = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'retry-race-submit-1')
      .set('X-Correlation-Id', 'retry-race-submit-1')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(raceSubmission.status).toBe(202);
    const raceJobId = String(raceSubmission.body.id);
    const raceCancel = await client
      .post(`/api/v1/jobs/${raceJobId}/cancel`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'retry-race-cancel-1')
      .set('X-Correlation-Id', 'retry-race-cancel-1');
    expect(raceCancel.status).toBe(200);
    const raceRetries = await Promise.all(
      ['retry-race-command-a', 'retry-race-command-b'].map((key) =>
        client
          .post(`/api/v1/jobs/${raceJobId}/retry`)
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .set('Idempotency-Key', key)
          .set('X-Correlation-Id', key),
      ),
    );
    expect(raceRetries.map(({ status }) => status).sort()).toEqual([202, 409]);
    const raceState = await runtime.db.query<{ status: string }>(
      'select status from jobs where id=$1',
      [raceJobId],
    );
    expect(raceState.rows[0]?.status).toBe('queued');
    expect(await runtime.httpCrawlQueue.getJob(raceJobId)).toBeDefined();
    await runtime.httpCrawlQueue.resume();
    await waitForCompleted(client, orphanJobId);
    await waitForCompleted(client, raceJobId);

    for (const endpoint of [
      `/api/v1/jobs/${crypto.randomUUID()}`,
      `/api/v1/jobs/${crypto.randomUUID()}/results`,
    ]) {
      expect((await client.get(endpoint).set('Authorization', `Bearer ${API_TOKEN}`)).status).toBe(
        404,
      );
    }
    expect(
      (
        await client
          .post(`/api/v1/jobs/${crypto.randomUUID()}/cancel`)
          .set('Authorization', `Bearer ${API_TOKEN}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await client
          .post(`/api/v1/jobs/${crypto.randomUUID()}/retry`)
          .set('Authorization', `Bearer ${API_TOKEN}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await client
          .post('/api/v1/webhooks/test')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .send({ url: 'https://unapproved.example.test/events' })
      ).status,
    ).toBe(400);
  });
});
