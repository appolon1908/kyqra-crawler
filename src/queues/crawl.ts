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

export const removeCrawlJob = async (runtime: Runtime, jobId: string): Promise<void> => {
  const jobs = await Promise.all([
    runtime.httpCrawlQueue.getJob(jobId),
    runtime.browserCrawlQueue.getJob(jobId),
  ]);
  await Promise.all(
    jobs.filter((job): job is Job<JobSpec> => Boolean(job)).map((job) => job.remove()),
  );
};
