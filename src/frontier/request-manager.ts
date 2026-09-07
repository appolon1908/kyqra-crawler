import { Request, type Source } from '@crawlee/core';
import type { Pool } from 'pg';

import {
  addFrontierRequests,
  claimFrontierRequests,
  frontierCounts,
  hasClaimableFrontierRequests,
  hasUnfinishedFrontierRequests,
  markFrontierHandled,
  reclaimFrontierRequest,
  type FrontierEntry,
} from '../storage/postgres/frontier.js';
import { canonicalizeUrl, urlHash } from './canonicalize.js';

interface ProcessedRequestLike {
  uniqueKey: string;
  requestId: string;
  wasAlreadyPresent: boolean;
  wasAlreadyHandled: boolean;
}

interface OperationInfoLike extends ProcessedRequestLike {
  forefront: boolean;
}

interface BatchResultLike {
  addedRequests: ProcessedRequestLike[];
  waitForAllRequestsToBeAdded: Promise<ProcessedRequestLike[]>;
  requestsOverLimit: Source[];
}

export interface PostgresFrontierOptions {
  db: Pool;
  jobId: string;
  workerId: string;
  /** Upper bound on the URLs this job may ever hold, mirroring the job's page budget. */
  maxRequests?: number;
  /** Delay applied when a failed request is returned to the pending pool. */
  reclaimDelaySeconds?: number;
}

interface RequestUserData {
  depth?: number;
}

const sourceUrl = (source: Source | string): string | undefined => {
  if (typeof source === 'string') return source;
  if (source instanceof Request) return source.url;
  return typeof source.url === 'string' ? source.url : undefined;
};

const sourceUserData = (source: Source | string): RequestUserData => {
  if (typeof source === 'string') return {};
  const data = source instanceof Request ? source.userData : source.userData;
  return (data ?? {}) as RequestUserData;
};

const toEntry = (source: Source | string): FrontierEntry | undefined => {
  const raw = sourceUrl(source);
  if (!raw) return undefined;
  try {
    const canonical = canonicalizeUrl(raw);
    const depth = sourceUserData(source).depth;
    return {
      url: canonical,
      urlHash: urlHash(canonical),
      host: new URL(canonical).hostname,
      depth: typeof depth === 'number' && depth >= 0 ? depth : 0,
    };
  } catch {
    return undefined;
  }
};

const collect = async (requests: Iterable<unknown> | AsyncIterable<unknown>): Promise<Source[]> => {
  const collected: Source[] = [];
  if (Symbol.asyncIterator in requests) {
    for await (const item of requests as AsyncIterable<Source>) collected.push(item);
    return collected;
  }
  for (const item of requests as Iterable<Source>) collected.push(item);
  return collected;
};

/**
 * Crawlee's request manager backed by the `frontier` table.
 *
 * Replaces `RequestQueue.open()`, which kept each job's frontier on the local disk of one
 * worker. Claims are rows in PostgreSQL with an owner and a visibility timeout, so a job
 * survives worker replacement, is recoverable by any replica, and is cleaned up with its
 * job rather than accumulating on a volume.
 */
export class PostgresFrontier {
  /** Never `default`: BasicCrawler drops a queue by that name when re-running. */
  public readonly name: string;
  /** Assigned by BasicCrawler, which treats a request manager as its request queue. */
  public internalTimeoutMillis = 300_000;
  public requestLockSecs = 60;

  private readonly db: Pool;
  private readonly jobId: string;
  private readonly workerId: string;
  private readonly maxRequests: number | undefined;
  private readonly reclaimDelaySeconds: number;
  private readonly inFlight = new Map<string, Request>();
  private totalCount = 0;
  private pendingCount = 0;
  private handled = 0;

  constructor(options: PostgresFrontierOptions) {
    this.db = options.db;
    this.jobId = options.jobId;
    this.workerId = options.workerId;
    this.maxRequests = options.maxRequests;
    this.reclaimDelaySeconds = options.reclaimDelaySeconds ?? 1;
    this.name = `job-${options.jobId}`;
  }

  /** Load the durable counters, so a resumed job reports the work it already did. */
  async initialize(): Promise<void> {
    const counts = await frontierCounts(this.db, this.jobId);
    this.totalCount = counts.pending + counts.claimed + counts.handled + counts.failed;
    this.pendingCount = counts.pending + counts.claimed;
    this.handled = counts.handled + counts.failed;
  }

  getTotalCount(): number {
    return this.totalCount;
  }

  getPendingCount(): number {
    return this.pendingCount;
  }

  async handledCount(): Promise<number> {
    return this.handled;
  }

  async isEmpty(): Promise<boolean> {
    return !(await hasClaimableFrontierRequests(this.db, this.jobId));
  }

  async isFinished(): Promise<boolean> {
    return !(await hasUnfinishedFrontierRequests(this.db, this.jobId));
  }

  async fetchNextRequest<T extends Record<string, unknown>>(): Promise<Request<T> | null> {
    const [claimed] = await claimFrontierRequests(this.db, this.jobId, this.workerId, 1);
    if (!claimed) return null;
    const request = new Request<T>({
      id: claimed.urlHash,
      url: claimed.url,
      uniqueKey: claimed.urlHash,
      userData: { depth: claimed.depth } as unknown as T,
    });
    this.inFlight.set(claimed.urlHash, request as unknown as Request);
    return request;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Request> {
    while (true) {
      const request = await this.fetchNextRequest();
      if (!request) break;
      yield request as unknown as Request;
    }
  }

  async markRequestHandled(request: Request): Promise<OperationInfoLike> {
    await markFrontierHandled(this.db, this.jobId, request.uniqueKey);
    this.inFlight.delete(request.uniqueKey);
    this.handled += 1;
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    return {
      uniqueKey: request.uniqueKey,
      requestId: request.uniqueKey,
      wasAlreadyPresent: true,
      wasAlreadyHandled: false,
      forefront: false,
    };
  }

  async reclaimRequest(request: Request): Promise<OperationInfoLike> {
    await reclaimFrontierRequest(this.db, this.jobId, request.uniqueKey, this.reclaimDelaySeconds);
    this.inFlight.delete(request.uniqueKey);
    return {
      uniqueKey: request.uniqueKey,
      requestId: request.uniqueKey,
      wasAlreadyPresent: true,
      wasAlreadyHandled: false,
      forefront: false,
    };
  }

  async addRequest(requestLike: Source): Promise<OperationInfoLike> {
    const [processed] = (await this.addRequestsBatched([requestLike])).addedRequests;
    const entry = toEntry(requestLike);
    const uniqueKey = processed?.uniqueKey ?? entry?.urlHash ?? '';
    return {
      uniqueKey,
      requestId: uniqueKey,
      wasAlreadyPresent: processed === undefined,
      wasAlreadyHandled: false,
      forefront: false,
    };
  }

  async addRequests(requestsLike: Iterable<Source> | AsyncIterable<Source>): Promise<{
    processedRequests: ProcessedRequestLike[];
    unprocessedRequests: never[];
  }> {
    const { addedRequests } = await this.addRequestsBatched(requestsLike);
    return { processedRequests: addedRequests, unprocessedRequests: [] };
  }

  async addRequestsBatched(
    requests: Iterable<unknown> | AsyncIterable<unknown>,
  ): Promise<BatchResultLike> {
    const sources = await collect(requests);
    const entries: FrontierEntry[] = [];
    const byHash = new Map<string, Source>();
    for (const source of sources) {
      const entry = toEntry(source);
      if (!entry || byHash.has(entry.urlHash)) continue;
      byHash.set(entry.urlHash, source);
      entries.push(entry);
    }

    // The page budget is enforced here as well as by the crawler, because the frontier is
    // shared: a per-crawler counter alone would let replicas collectively overshoot it.
    let admitted = entries;
    const requestsOverLimit: Source[] = [];
    if (this.maxRequests !== undefined) {
      const counts = await frontierCounts(this.db, this.jobId);
      const known = counts.pending + counts.claimed + counts.handled + counts.failed;
      const room = Math.max(0, this.maxRequests - known);
      if (entries.length > room) {
        admitted = entries.slice(0, room);
        for (const entry of entries.slice(room)) {
          const source = byHash.get(entry.urlHash);
          if (source) requestsOverLimit.push(source);
        }
      }
    }

    const { added } = await addFrontierRequests(this.db, this.jobId, admitted);
    this.totalCount += added.length;
    this.pendingCount += added.length;
    const addedRequests: ProcessedRequestLike[] = added.map((hash) => ({
      uniqueKey: hash,
      requestId: hash,
      wasAlreadyPresent: false,
      wasAlreadyHandled: false,
    }));
    return {
      addedRequests,
      waitForAllRequestsToBeAdded: Promise.resolve(addedRequests),
      requestsOverLimit,
    };
  }

  /** URL hashes this instance currently holds a claim on. */
  outstandingClaims(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Hand every claim this instance still holds back to the pending pool. Graceful
   * shutdown calls this so a redeploy does not wait out the visibility timeout.
   */
  async releaseOutstandingClaims(): Promise<number> {
    const outstanding = this.outstandingClaims();
    for (const hash of outstanding) {
      await reclaimFrontierRequest(this.db, this.jobId, hash, 0);
    }
    this.inFlight.clear();
    return outstanding.length;
  }

  /** BasicCrawler only calls this for a queue named `default`, which this never is. */
  async drop(): Promise<void> {
    // The frontier outlives one crawler run on purpose; job completion deletes it.
  }
}
