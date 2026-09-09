import type { Job, Queue } from 'bullmq';

import type { JobSpec } from '../config/schema.js';
import type { CrawlWorkerKind, Runtime } from '../types.js';

export const crawlWorkerKindForSpec = (spec: JobSpec): CrawlWorkerKind =>
  spec.browser === 'playwright' ? 'browser' : 'http';

export const crawlQueueForKind = (runtime: Runtime, kind: CrawlWorkerKind): Queue<JobSpec> =>
  kind === 'browser' ? runtime.browserCrawlQueue : runtime.httpCrawlQueue;

export const crawlQueueForSpec = (runtime: Runtime, spec: JobSpec): Queue<JobSpec> =>
  crawlQueueForKind(runtime, crawlWorkerKindForSpec(spec));

export const findCrawlJob = async (
  runtime: Runtime,
  jobId: string,
): Promise<Job<JobSpec> | undefined> => {
  const [http, browser] = await Promise.all([
    runtime.httpCrawlQueue.getJob(jobId),
    runtime.browserCrawlQueue.getJob(jobId),
  ]);
  return http || browser || undefined;
};

export interface RemoveCrawlJobOptions {
  /**
   * How long to keep trying when the queue entry is still locked by a worker. Re-queuing
   * a job reuses its id, so the previous attempt has to release it first; without this
   * wait a retry issued moments after a cancellation races the worker's teardown.
   */
  waitMs?: number;
}

export const removeCrawlJob = async (
  runtime: Runtime,
  jobId: string,
  options: RemoveCrawlJobOptions = {},
): Promise<void> => {
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    const jobs = (
      await Promise.all([
        runtime.httpCrawlQueue.getJob(jobId),
        runtime.browserCrawlQueue.getJob(jobId),
      ])
    ).filter((job): job is Job<JobSpec> => Boolean(job));
    if (jobs.length === 0) return;

    // BullMQ refuses to remove a job a worker still holds. Wait for it to leave the active
    // state rather than retrying the removal blindly, so the wait tracks the thing that is
    // actually blocking instead of hoping the next attempt lands differently.
    const states = await Promise.all(
      jobs.map((job) => job.getState().catch((): string => 'unknown')),
    );
    if (states.includes('active') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }

    try {
      await Promise.all(jobs.map((job) => job.remove()));
      return;
    } catch (error: unknown) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
};
