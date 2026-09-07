import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';

import { databaseUrl, redisConnectionOptions } from './config/env.js';
import type { JobSpec } from './config/schema.js';
import type { CallbackJobData, Runtime } from './types.js';

export const createRuntime = (): Runtime => {
  const redisConnection = redisConnectionOptions();
  const redis = new Redis(redisConnection);
  const db = new pg.Pool({ connectionString: databaseUrl() });
  const httpCrawlQueue = new Queue<JobSpec>('crawl-http', {
    connection: redisConnection,
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  });
  const browserCrawlQueue = new Queue<JobSpec>('crawl-browser', {
    connection: redisConnection,
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  });
  const callbackQueue = new Queue<CallbackJobData>('callbacks', {
    connection: redisConnection,
    defaultJobOptions: { attempts: 6, backoff: { type: 'exponential', delay: 10000 } },
  });

  return { db, redis, httpCrawlQueue, browserCrawlQueue, callbackQueue, redisConnection };
};

export const closeRuntime = async (runtime: Runtime): Promise<void> => {
  await Promise.all([
    runtime.httpCrawlQueue.close(),
    runtime.browserCrawlQueue.close(),
    runtime.callbackQueue.close(),
    runtime.redis.quit(),
    runtime.db.end(),
  ]);
};
