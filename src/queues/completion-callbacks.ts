import type { JobSpec } from '../config/schema.js';
import { isCallbackAllowed } from '../delivery/security.js';
import { getJobMetadata, listResultsForCallbacks } from '../storage/postgres/repository.js';
import type { CallbackJobData, Runtime } from '../types.js';

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
    for (const row of rows) {
      await enqueueOrReviveCallback(
        runtime,
        'result',
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
        `kyqra-result-${jobId}-${row.id}`,
      );
    }
    await enqueueOrReviveCallback(
      runtime,
      'progress',
      {
        jobId,
        url: `${middlewareBaseUrl}/api/v1/kyqra/progress`,
        payload: {
          job_id: jobId,
          tenant_id: metadata?.tenant_id ?? null,
          correlation_id: metadata?.correlation_id ?? null,
          status: 'completed',
          ...progress,
        },
      },
      `kyqra-progress-${jobId}`,
    );
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
