import crypto from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  cancelJob,
  checkPostgresReady,
  getJobEvents,
  getJobPayload,
  getJobStatus,
  createSourceProfile,
  disableSourceProfile,
  getSourceProfile,
  listSourceProfiles,
  type SourceProfileRow,
  listJobs,
  ownsJob,
  recordJobEnqueueOutcome,
  resetJobQueued,
  markJobFailed,
  type JobStatusRow,
} from '../storage/postgres/repository.js';
import { crawlQueueForSpec, findCrawlJob, removeCrawlJob } from '../queues/crawl.js';
import { publishJobCancellation } from '../workers/cancellation.js';
import {
  queueCompletionCallbacks,
  storedCompletionProgress,
} from '../queues/completion-callbacks.js';
import type { Runtime } from '../types.js';
import { sourceProfileSchema } from '../config/schema.js';
import { validateCrawlTarget } from '../delivery/security.js';
import { executeDurableCommand } from './idempotency.js';
import { kyqraOpenApi } from './openapi.js';

interface IdParams {
  id: string;
}

const notFound = (reply: FastifyReply): FastifyReply =>
  reply.code(404).send({ error: 'not_found' });

const operationStatus = (status: string): string =>
  ({
    queued: 'QUEUED',
    running: 'PROCESSING',
    completed: 'SUCCEEDED',
    failed: 'FAILED',
    cancelled: 'CANCELLED',
  })[status] || 'RECONCILIATION_REQUIRED';

const operationView = (job: JobStatusRow) => ({
  ...job,
  operation_id: job.id,
  status: operationStatus(job.status),
});

export const registerCanonicalApi = (app: FastifyInstance, runtime: Runtime): void => {
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async () => {
    await runtime.redis.ping();
    await checkPostgresReady(runtime.db);
    return { status: 'ready', redis: 'ok', postgres: 'ok' };
  });
  app.get('/openapi.json', async () => kyqraOpenApi);

  app.get('/api/v1/me', async (request) => ({
    tenant_id: request.servicePrincipal.tenant_id,
    client_id: request.servicePrincipal.client_id,
    roles: request.servicePrincipal.roles || [],
  }));
  app.get('/api/v1/capabilities', async (request) => ({
    tenant_id: request.servicePrincipal.tenant_id,
    capabilities: ['crawl.jobs', 'crawl.results', 'crawl.events', 'operations'],
  }));

  const sourceView = (row: SourceProfileRow) => ({
    id: row.id,
    source_id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    base_url: row.base_url,
    enabled: row.enabled,
    profile: row.profile,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  app.post('/api/v1/sources', async (request, reply) => {
    const parsed = sourceProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_source', details: parsed.error.issues });
    }
    try {
      await validateCrawlTarget(parsed.data.baseUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'crawl_target_denied';
      return reply.code(400).send({ error: message });
    }
    return executeDurableCommand(
      runtime,
      request,
      reply,
      { action: 'source.create', resource: 'sources', payload: parsed.data },
      async () => {
        const row = await createSourceProfile(runtime.db, {
          id: crypto.randomUUID(),
          tenantId: request.servicePrincipal.tenant_id,
          profile: parsed.data,
        });
        return { code: 201, body: sourceView(row) };
      },
    );
  });

  app.get('/api/v1/sources', async (request) => ({
    items: (await listSourceProfiles(runtime.db, request.servicePrincipal.tenant_id)).map(
      sourceView,
    ),
  }));

  app.get<{ Params: IdParams }>('/api/v1/sources/:id', async (request, reply) => {
    const row = await getSourceProfile(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    return row ? sourceView(row) : notFound(reply);
  });

  app.post<{ Params: IdParams }>('/api/v1/sources/:id/disable', async (request, reply) => {
    const current = await getSourceProfile(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!current) return notFound(reply);
    return executeDurableCommand(
      runtime,
      request,
      reply,
      { action: 'source.disable', resource: `sources/${request.params.id}`, payload: {} },
      async () => {
        const disabled = await disableSourceProfile(
          runtime.db,
          request.params.id,
          request.servicePrincipal.tenant_id,
        );
        return disabled
          ? { code: 200, body: { id: request.params.id, status: 'disabled' } }
          : { code: 409, body: { id: request.params.id, error: 'source_state_changed' } };
      },
    );
  });

  app.get('/api/v1/jobs', async (request) => ({
    items: await listJobs(runtime.db, request.servicePrincipal.tenant_id, 200),
  }));
  app.get<{ Params: IdParams }>('/api/v1/jobs/:id/events', async (request, reply) => {
    if (!(await ownsJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id))) {
      return notFound(reply);
    }
    return {
      job_id: request.params.id,
      items: await getJobEvents(runtime.db, request.params.id, request.servicePrincipal.tenant_id),
    };
  });

  app.get('/api/v1/operations', async (request) => ({
    items: (await listJobs(runtime.db, request.servicePrincipal.tenant_id, 200)).map(operationView),
  }));
  app.get<{ Params: IdParams }>('/api/v1/operations/:id', async (request, reply) => {
    const job = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    return job ? operationView(job) : notFound(reply);
  });
  app.get<{ Params: IdParams }>('/api/v1/operations/:id/events', async (request, reply) => {
    if (!(await ownsJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id))) {
      return notFound(reply);
    }
    return {
      operation_id: request.params.id,
      items: await getJobEvents(runtime.db, request.params.id, request.servicePrincipal.tenant_id),
    };
  });
  app.get<{ Params: IdParams }>('/api/v1/operations/:id/attempts', async (request, reply) => {
    if (!(await ownsJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id))) {
      return notFound(reply);
    }
    const events = await getJobEvents(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    return {
      operation_id: request.params.id,
      items: events.filter(({ status }) =>
        ['running', 'failed', 'completed'].includes(String(status)),
      ),
    };
  });
  app.post<{ Params: IdParams }>('/api/v1/operations/:id/cancel', async (request, reply) => {
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
      { action: 'operation.cancel', resource: `operations/${request.params.id}`, payload: {} },
      async () => {
        const cancelled = await cancelJob(
          runtime.db,
          request.params.id,
          request.servicePrincipal.tenant_id,
        );
        if (cancelled) {
          await removeCrawlJob(runtime, request.params.id).catch(() => undefined);
          // Reach a crawl that is already running: the queue entry is gone, but a worker
          // holding the job only stops fetching once it sees the cancellation.
          await publishJobCancellation(runtime, request.params.id).catch(() => undefined);
        }
        return cancelled
          ? {
              code: 200,
              body: { operation_id: request.params.id, status: 'CANCELLED' },
            }
          : {
              code: 409,
              body: {
                operation_id: request.params.id,
                status: operationStatus(current.status),
                error: 'operation_terminal',
              },
            };
      },
    );
  });
  app.post<{ Params: IdParams }>('/api/v1/operations/:id/reconcile', async (request, reply) => {
    const job = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!job) return notFound(reply);
    return executeDurableCommand(
      runtime,
      request,
      reply,
      { action: 'operation.reconcile', resource: `operations/${request.params.id}`, payload: {} },
      async () => {
        const payload = await getJobPayload(runtime.db, job.id, request.servicePrincipal.tenant_id);
        if (!payload) return { code: 404, body: { error: 'not_found' } };
        if (job.status === 'completed') {
          await queueCompletionCallbacks(
            runtime,
            job.id,
            payload,
            storedCompletionProgress(job.progress),
          );
          return {
            code: 202,
            body: {
              operation_id: job.id,
              status: 'SUCCEEDED',
              callbacks_reconciled: true,
            },
          };
        }
        if (job.status === 'queued') {
          const queueJob = await findCrawlJob(runtime, job.id);
          if (queueJob) {
            const queueState = await queueJob.getState();
            if (
              ['active', 'delayed', 'prioritized', 'waiting', 'waiting-children'].includes(
                queueState,
              )
            ) {
              await recordJobEnqueueOutcome(runtime.db, job.id, 'QUEUED');
              return {
                code: 200,
                body: {
                  operation_id: job.id,
                  status: 'QUEUED',
                  reconciliation_required: false,
                },
              };
            }
            await removeCrawlJob(runtime, job.id, { waitMs: 20_000 });
          }
          try {
            await crawlQueueForSpec(runtime, payload).add('crawl', payload, { jobId: job.id });
          } catch (error: unknown) {
            await markJobFailed(runtime.db, job.id, 'queue_reconcile_failed');
            throw error;
          }
          await recordJobEnqueueOutcome(runtime.db, job.id, 'QUEUED');
          return {
            code: 202,
            body: {
              operation_id: job.id,
              status: 'QUEUED',
              reconciliation_required: false,
              queue_entry_recreated: true,
            },
          };
        }
        if (!['failed', 'cancelled'].includes(job.status)) {
          return {
            code: 200,
            body: {
              operation_id: job.id,
              status: operationStatus(job.status),
              reconciliation_required: false,
            },
          };
        }
        const reset = await resetJobQueued(runtime.db, job.id, request.servicePrincipal.tenant_id);
        if (!reset) {
          return {
            code: 409,
            body: { operation_id: job.id, error: 'operation_state_changed' },
          };
        }
        try {
          await removeCrawlJob(runtime, job.id, { waitMs: 20_000 });
          await crawlQueueForSpec(runtime, payload).add('crawl', payload, { jobId: job.id });
        } catch (error: unknown) {
          await markJobFailed(runtime.db, job.id, 'queue_reconcile_failed');
          throw error;
        }
        return {
          code: 202,
          body: {
            operation_id: job.id,
            status: 'QUEUED',
            reconciliation_required: false,
          },
        };
      },
    );
  });

  app.get('/metrics', async (request, reply) => {
    if (!request.servicePrincipal.roles?.includes('operations')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const counts = await runtime.db.query<{ status: string; count: string }>(
      'select status,count(*)::text as count from jobs group by status',
    );
    const body =
      [
        '# HELP kyqra_jobs Jobs by durable state',
        '# TYPE kyqra_jobs gauge',
        ...counts.rows.map(
          ({ status, count }) => `kyqra_jobs{status="${status.replaceAll('"', '')}"} ${count}`,
        ),
      ].join('\n') + '\n';
    return reply.type('text/plain; version=0.0.4').send(body);
  });
};
