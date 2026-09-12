import crypto from 'node:crypto';

import type { JobSpec } from '../config/schema.js';
import { isCallbackAllowed } from '../delivery/security.js';
import { getJobMetadata, listResultsForCallbacks } from '../storage/postgres/repository.js';
import type { CallbackJobData, Runtime } from '../types.js';
import { buildCrawlerCompletionEvent } from '../integration/crawler-events.js';

export interface CompletionProgress {
  processed: number;
  records: number;
  failed: number;
}

export const storedCompletionProgress = (value: unknown): CompletionProgress => {
  const stored = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    processed: Number.isSafeInteger(stored.processed) ? Number(stored.processed) : 0,
    records: Number.isSafeInteger(stored.records) ? Number(stored.records) : 0,
    failed: Number.isSafeInteger(stored.failed) ? Number(stored.failed) : 0,
  };
};

const enqueueOrReviveCallback = async (
  runtime: Runtime,
  name: string,
  data: CallbackJobData,
  jobId: string,
): Promise<void> => {
  const existing = await runtime.callbackQueue.getJob(jobId);
  if (existing) {
    if ((await existing.getState()) === 'failed') await existing.retry('failed');
    return;
  }
  await runtime.callbackQueue.add(name, data, { jobId });
};

export const queueCompletionCallbacks = async (
  runtime: Runtime,
  jobId: string,
  spec: JobSpec,
  progress: CompletionProgress,
): Promise<void> => {
  const middlewareBaseUrl = (process.env.MIDDLEWARE_BASE_URL || '').replace(/\/$/, '');
  const metadata = await getJobMetadata(runtime.db, jobId);
  if (middlewareBaseUrl) {
    const rows = await listResultsForCallbacks(runtime.db, jobId);
    const eventId = crypto.randomUUID();
    const envelope = buildCrawlerCompletionEvent({
      eventId,
      jobId,
      metadata,
      progress,
      rows,
    });
    const configuredPath = (process.env.KYQRA_MIDDLEWARE_WEBHOOK_PATH || '/v1/webhooks/crawler/kyqra').trim();
    const path = configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`;
    await enqueueOrReviveCallback(
      runtime,
      'job.completed',
      {
        jobId,
        url: `${middlewareBaseUrl}${path}`,
        payload: envelope as unknown as Record<string, unknown>,
        event: envelope.event_type,
        eventId,
        signatureMode: 'codestra-v1',
        sourceClientId: 'kyqra-gateway',
      },
      `kyqra-event-${jobId}-completed`,
    );

    // The old per-row endpoints remain available only as an explicit compatibility escape
    // hatch; the canonical integration is one signed, replay-safe event.
    if (process.env.KYQRA_LEGACY_CALLBACKS_ENABLED === 'true') {
      for (const row of rows) {
        await enqueueOrReviveCallback(
          runtime,
          'legacy-result',
          {
            jobId,
            url: `${middlewareBaseUrl}/api/v1/kyqra/results`,
            payload: {
              job_id: jobId,
              tenant_id: metadata?.tenant_id ?? null,
              correlation_id: metadata?.correlation_id ?? null,
              record_id: row.id,
              ...row.data,
              category: row.data.category ?? null,
              confidence: row.data.confidence ?? null,
              provenance: row.provenance,
            },
          },
          `kyqra-legacy-result-${jobId}-${row.id}`,
        );
      }
    }
  }
  if (spec.callbackUrl && isCallbackAllowed(spec.callbackUrl)) {
    await enqueueOrReviveCallback(
      runtime,
      'complete',
      {
        jobId,
        url: spec.callbackUrl,
        payload: { job_id: jobId, status: 'completed', ...progress },
      },
      `kyqra-complete-${jobId}`,
    );
  }
};
