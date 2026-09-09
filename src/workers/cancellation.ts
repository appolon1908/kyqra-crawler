import { getInternalJobStatus } from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';

/** Channel a cancelling API replica publishes on so workers react without waiting for a poll. */
export const JOB_CANCEL_CHANNEL = 'kyqra:job:cancel';

/** How often the database is consulted when no message arrives. */
export const DEFAULT_CANCEL_POLL_MS = 1_000;

export interface CancellationWatch {
  /** Aborts as soon as the job stops being runnable. */
  readonly signal: AbortSignal;
  /** Why the watch aborted, once it has. */
  reason: () => string | undefined;
  stop: () => Promise<void>;
}

export interface CancellationWatchOptions {
  pollIntervalMs?: number;
}

/**
 * Tell every worker that a job is no longer runnable. Delivery is best effort: the
 * database row is the source of truth and {@link watchJobCancellation} polls it, so a
 * dropped message delays detection to one poll interval rather than losing it.
 */
export const publishJobCancellation = async (runtime: Runtime, jobId: string): Promise<void> => {
  await runtime.redis.publish(JOB_CANCEL_CHANNEL, jobId);
};

/**
 * Watch one job for cancellation and expose it as an `AbortSignal`.
 *
 * Cancellation previously only took effect between requests, so an in-flight fetch could
 * keep running for the whole request-handler timeout. The signal returned here is wired
 * into the rate limiter's waits, the HTTP client, and the autoscaled pool, so fetching
 * stops promptly rather than at the next request boundary.
 *
 * A dedicated subscriber connection is used because a Redis client in subscriber mode
 * cannot serve ordinary commands. One connection per running job is acceptable: job
 * concurrency per worker is small and bounded by `JOB_CONCURRENCY`.
 */
export const watchJobCancellation = async (
  runtime: Runtime,
  jobId: string,
  options: CancellationWatchOptions = {},
): Promise<CancellationWatch> => {
  const controller = new AbortController();
  let reason: string | undefined;
  const cancel = (why: string): void => {
    if (controller.signal.aborted) return;
    reason = why;
    controller.abort();
  };

  const subscriber = runtime.redis.duplicate();
  subscriber.on('error', () => undefined);
  subscriber.on('message', (_channel: string, message: string) => {
    if (message === jobId) cancel('cancelled');
  });
  await subscriber.subscribe(JOB_CANCEL_CHANNEL);

  const poll = setInterval(() => {
    void getInternalJobStatus(runtime.db, jobId)
      .then((status) => {
        if (status !== 'running') cancel(`job_${status ?? 'missing'}`);
      })
      .catch(() => undefined);
  }, options.pollIntervalMs ?? DEFAULT_CANCEL_POLL_MS);
  // A pending poll must never hold the process open during shutdown.
  poll.unref();

  return {
    signal: controller.signal,
    reason: () => reason,
    stop: async (): Promise<void> => {
      clearInterval(poll);
      await subscriber.unsubscribe(JOB_CANCEL_CHANNEL).catch(() => undefined);
      await subscriber.quit().catch(() => subscriber.disconnect());
    },
  };
};
