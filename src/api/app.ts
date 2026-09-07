import crypto from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { browserConcurrency, httpConcurrency } from '../config/env.js';
import { jobSpecSchema } from '../config/schema.js';
import { isCallbackAllowed, validateCrawlTarget } from '../delivery/security.js';
import { crawlQueueForSpec, removeCrawlJob } from '../queues/crawl.js';
import {
  cancelJob,
  checkPostgresReady,
  createJob,
  findIdempotentJob,
  getJobPayload,
  getJobResults,
  getJobStatus,
  markJobFailed,
  recordJobEnqueueOutcome,
  resetJobQueued,
  type IdempotentJob,
  type JobResultRow,
} from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';
import { authenticate } from './auth.js';
import { registerCanonicalApi } from './canonical.js';
import { dashboardHtml } from './dashboard.js';
import { executeDurableCommand, requireCommandHeaders, semanticHash } from './idempotency.js';

interface JobParams {
  id: string;
}

interface ResultsQuery {
  format?: string;
}

interface WebhookTestBody {
  url?: string;
}

const publicPaths = [
  '/',
  '/health',
  '/healthz',
  '/readyz',
  '/health/live',
  '/health/ready',
  '/api/v1/health',
  '/openapi.json',
];

const csvEscape = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;

const resultsCsv = (rows: JobResultRow[]): string =>
  `source_url,business_name,website,phone,email,address\n${rows
    .map((row) =>
      [
        row.data.source_url,
        row.data.business_name,
        row.data.website,
        row.data.phone.join(';'),
        row.data.email.join(';'),
        row.data.address,
      ]
        .map(csvEscape)
        .join(','),
    )
    .join('\n')}`;

const notFound = (reply: FastifyReply): FastifyReply =>
  reply.code(404).send({ error: 'not_found' });

const sendIdempotentJob = (reply: FastifyReply, prior: IdempotentJob): FastifyReply => {
  if (
    prior.enqueue_outcome === 'FAILED' ||
    (prior.enqueue_outcome === 'PENDING' && prior.status === 'failed')
  ) {
    return reply.code(503).send({
      id: prior.job_id,
      status: 'failed',
      duplicate: true,
      reconciliation_required: true,
      correlation_id: prior.correlation_id,
    });
  }
  if (prior.enqueue_outcome === 'PENDING' && prior.status === 'queued') {
    return reply.code(409).send({
      id: prior.job_id,
      status: 'pending',
      duplicate: true,
      reconciliation_required: true,
      correlation_id: prior.correlation_id,
    });
  }
  return reply.code(200).send({
    id: prior.job_id,
    status: 'duplicate',
    duplicate: true,
    correlation_id: prior.correlation_id,
  });
};

const enforceRate = async (runtime: Runtime, tenantId: string): Promise<void> => {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `kyqra:rate:${tenantId}:${minute}`;
  const value = await runtime.redis.incr(key);
  if (value === 1) await runtime.redis.expire(key, 120);
  const configured = Number(process.env.KYQRA_JOBS_PER_MINUTE || 30);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 30;
  if (value > limit) throw new Error('rate_limit_exceeded');
};

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

export const buildApi = async (runtime: Runtime): Promise<FastifyInstance> => {
  const app = Fastify({ bodyLimit: 2_000_000 });
  const live = async (): Promise<{ status: string }> => ({ status: 'ok' });
  const ready = async (): Promise<{ status: string; redis: string; postgres: string }> => {
    await runtime.redis.ping();
    await checkPostgresReady(runtime.db);
    return { status: 'ok', redis: 'ok', postgres: 'ok' };
  };

  app.get('/health', ready);
  app.get('/healthz', live);
  app.get('/readyz', ready);
  app.get('/api/v1/health', live);
  app.addHook('onRequest', (request, reply, done) => {
    if (publicPaths.includes(request.url)) done();
    else authenticate(request, reply, done);
  });

  app.post('/api/v1/jobs', async (request, reply) => {
    const parsed = jobSpecSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_job', details: parsed.error.issues });
    }
    if (parsed.data.callbackUrl && !isCallbackAllowed(parsed.data.callbackUrl)) {
      return reply.code(400).send({ error: 'callback_not_allowed' });
    }
    const headers = requireCommandHeaders(request, reply);
    if (!headers) return reply;
    const tenantId = request.servicePrincipal.tenant_id;
    const requestHash = semanticHash(parsed.data);
    let prior = await findIdempotentJob(
      runtime.db,
      tenantId,
      request.servicePrincipal.client_id,
      headers.idempotencyKey,
    );
    if (prior) {
      if (prior.request_hash !== requestHash) {
        return reply.code(409).send({ error: 'idempotency_conflict' });
      }
      return sendIdempotentJob(reply, prior);
    }
    try {
      await Promise.all(parsed.data.startUrls.map((url) => validateCrawlTarget(url)));
      await enforceRate(runtime, tenantId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'crawl_target_denied';
      return reply.code(message === 'rate_limit_exceeded' ? 429 : 400).send({ error: message });
    }
    const jobId = crypto.randomUUID();
    try {
      await createJob(
        runtime.db,
        jobId,
        parsed.data,
        headers.idempotencyKey,
        requestHash,
        headers.correlationId,
        tenantId,
        request.servicePrincipal.client_id,
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      prior = await findIdempotentJob(
        runtime.db,
        tenantId,
        request.servicePrincipal.client_id,
        headers.idempotencyKey,
      );
      if (!prior) throw error;
      if (prior.request_hash !== requestHash) {
        return reply.code(409).send({ error: 'idempotency_conflict' });
      }
      return sendIdempotentJob(reply, prior);
    }
    try {
      await crawlQueueForSpec(runtime, parsed.data).add('crawl', parsed.data, { jobId });
    } catch {
      await recordJobEnqueueOutcome(runtime.db, jobId, 'FAILED');
      await markJobFailed(runtime.db, jobId, 'queue_enqueue_failed');
      return reply.code(503).send({
        id: jobId,
        status: 'failed',
        duplicate: false,
        reconciliation_required: true,
        correlation_id: headers.correlationId,
      });
    }
    await recordJobEnqueueOutcome(runtime.db, jobId, 'QUEUED');
    return reply.code(202).send({
      id: jobId,
      status: 'queued',
      duplicate: false,
      correlation_id: headers.correlationId,
    });
  });

  app.get<{ Params: JobParams }>('/api/v1/jobs/:id', async (request, reply) => {
    const status = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    return status ?? notFound(reply);
  });

  app.get<{ Params: JobParams; Querystring: ResultsQuery }>(
    '/api/v1/jobs/:id/results',
    async (request, reply) => {
      const results = await getJobResults(
        runtime.db,
        request.params.id,
        request.servicePrincipal.tenant_id,
      );
      if (!results) return notFound(reply);
      if (request.query.format === 'csv') {
        return reply.type('text/csv').send(resultsCsv(results.rows));
      }
      return {
        count: results.rows.length,
        correlation_id: results.correlationId,
        results: results.rows,
      };
    },
  );

  app.post<{ Params: JobParams }>('/api/v1/jobs/:id/cancel', async (request, reply) => {
    const current = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!current) return notFound(reply);
    return executeDurableCommand(
      runtime,
      request,
      reply,
      { action: 'job.cancel', resource: `jobs/${request.params.id}`, payload: {} },
      async () => {
        const cancelled = await cancelJob(
          runtime.db,
          request.params.id,
          request.servicePrincipal.tenant_id,
        );
        if (cancelled) {
          await removeCrawlJob(runtime, request.params.id).catch(() => undefined);
        }
        return cancelled
          ? { code: 200, body: { id: request.params.id, status: 'cancelled' } }
          : { code: 409, body: { id: request.params.id, error: 'job_terminal' } };
      },
    );
  });

  app.post<{ Params: JobParams }>('/api/v1/jobs/:id/retry', async (request, reply) => {
    const status = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!status) return notFound(reply);
    const payload = await getJobPayload(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!payload) return notFound(reply);
    return executeDurableCommand(
      runtime,
      request,
      reply,
      { action: 'job.retry', resource: `jobs/${request.params.id}`, payload: {} },
      async () => {
        if (!['failed', 'cancelled'].includes(status.status)) {
          return { code: 409, body: { id: request.params.id, error: 'job_not_retryable' } };
        }
        const reset = await resetJobQueued(
          runtime.db,
          request.params.id,
          request.servicePrincipal.tenant_id,
        );
        if (!reset) {
          return { code: 409, body: { id: request.params.id, error: 'job_state_changed' } };
        }
        try {
          await removeCrawlJob(runtime, request.params.id);
          await crawlQueueForSpec(runtime, payload).add('crawl', payload, {
            jobId: request.params.id,
          });
        } catch (error: unknown) {
          await markJobFailed(runtime.db, request.params.id, 'queue_retry_failed');
          throw error;
        }
        return { code: 202, body: { id: request.params.id, status: 'accepted' } };
      },
    );
  });

  app.get('/api/v1/stats', async (request, reply) => {
    if (!request.servicePrincipal.roles?.includes('operations')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return {
      queues: {
        http: await runtime.httpCrawlQueue.getJobCounts(),
        browser: await runtime.browserCrawlQueue.getJobCounts(),
      },
      workers: { http: httpConcurrency(), browser: browserConcurrency() },
    };
  });

  app.post<{ Body: WebhookTestBody }>('/api/v1/webhooks/test', async (request, reply) => {
    if (!request.servicePrincipal.roles?.includes('operations')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!request.body?.url || !isCallbackAllowed(request.body.url)) {
      return reply.code(400).send({ error: 'callback_not_allowed' });
    }
    const webhookUrl = request.body.url;
    return executeDurableCommand(
      runtime,
      request,
      reply,
      { action: 'webhook.test', resource: 'webhooks/test', payload: request.body },
      async () => {
        const queueId = `webhook-test-${semanticHash({
          tenant: request.servicePrincipal.tenant_id,
          caller: request.servicePrincipal.client_id,
          key: request.headers['idempotency-key'],
        })}`;
        await runtime.callbackQueue.add(
          'test',
          { jobId: 'test', url: webhookUrl, event: 'test', payload: { event: 'test' } },
          { jobId: queueId },
        );
        return { code: 202, body: { queued: true, operation_id: queueId } };
      },
    );
  });

  registerCanonicalApi(app, runtime);

  app.get('/', async (_request, reply) => reply.type('text/html').send(dashboardHtml()));
  return app;
};

export const startApi = async (runtime: Runtime): Promise<FastifyInstance> => {
  const app = await buildApi(runtime);
  await app.listen({ host: '0.0.0.0', port: 3000 });
  return app;
};
