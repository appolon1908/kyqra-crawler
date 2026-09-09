import type { Pool } from 'pg';

/** A URL offered to the frontier. */
export interface FrontierEntry {
  url: string;
  urlHash: string;
  host: string;
  depth: number;
  priority?: number;
}

/** A URL a worker currently holds a claim on. */
export interface ClaimedFrontierRequest {
  url: string;
  urlHash: string;
  host: string;
  depth: number;
  attempts: number;
}

export interface FrontierCounts {
  pending: number;
  claimed: number;
  handled: number;
  failed: number;
}

export interface FrontierAddResult {
  /** URL hashes that were newly inserted. */
  added: string[];
  /** URL hashes that the frontier already knew about, in any state. */
  existing: string[];
}

/**
 * Insert URLs the frontier has not seen for this job. The primary key is
 * `(job_id, url_hash)`, so a URL discovered twice is inserted once and never re-crawled,
 * and the insert is safe to run concurrently from several workers.
 */
export const addFrontierRequests = async (
  db: Pool,
  jobId: string,
  entries: FrontierEntry[],
): Promise<FrontierAddResult> => {
  if (entries.length === 0) return { added: [], existing: [] };
  // De-duplicate within the batch as well; ON CONFLICT cannot fix a row that the same
  // statement inserts twice.
  const unique = [...new Map(entries.map((entry) => [entry.urlHash, entry])).values()];
  const inserted = await db.query<{ url_hash: string }>(
    `insert into frontier (job_id,url_hash,url,host,depth,priority,state)
     select $1, entry.url_hash, entry.url, entry.host, entry.depth, entry.priority, 'pending'
     from unnest($2::text[],$3::text[],$4::text[],$5::int[],$6::int[])
       as entry(url_hash,url,host,depth,priority)
     on conflict (job_id,url_hash) do nothing
     returning url_hash`,
    [
      jobId,
      unique.map((entry) => entry.urlHash),
      unique.map((entry) => entry.url),
      unique.map((entry) => entry.host),
      unique.map((entry) => entry.depth),
      unique.map((entry) => entry.priority ?? 0),
    ],
  );
  const added = new Set(inserted.rows.map((row) => row.url_hash));
  return {
    added: [...added],
    existing: unique.map((entry) => entry.urlHash).filter((hash) => !added.has(hash)),
  };
};

/**
 * Claim due work for a job. `for update skip locked` lets every replica claim disjoint
 * rows from the same frontier without blocking on each other, which is what makes the
 * frontier shared rather than worker-local.
 */
export const claimFrontierRequests = async (
  db: Pool,
  jobId: string,
  workerId: string,
  limit: number,
): Promise<ClaimedFrontierRequest[]> => {
  const claimed = await db.query<{
    url: string;
    url_hash: string;
    host: string;
    depth: number;
    attempts: number;
  }>(
    `update frontier target
     set state='claimed', claimed_by=$2, claimed_at=now(), updated_at=now()
     from (
       select job_id,url_hash from frontier
       where job_id=$1 and state='pending' and scheduled_for<=now()
       order by priority desc, scheduled_for, url_hash
       for update skip locked
       limit $3
     ) due
     where target.job_id=due.job_id and target.url_hash=due.url_hash
     returning target.url, target.url_hash, target.host, target.depth, target.attempts`,
    [jobId, workerId, limit],
  );
  return claimed.rows.map((row) => ({
    url: row.url,
    urlHash: row.url_hash,
    host: row.host,
    depth: row.depth,
    attempts: row.attempts,
  }));
};

/** A row already recorded as failed keeps that outcome; Crawlee marks it handled last. */
export const markFrontierHandled = async (
  db: Pool,
  jobId: string,
  urlHash: string,
): Promise<void> => {
  await db.query(
    `update frontier
     set state='handled', claimed_by=null, claimed_at=null, updated_at=now()
     where job_id=$1 and url_hash=$2 and state<>'failed'`,
    [jobId, urlHash],
  );
};

export const markFrontierFailed = async (
  db: Pool,
  jobId: string,
  urlHash: string,
  reason: string,
): Promise<void> => {
  await db.query(
    `update frontier
     set state='failed', claimed_by=null, claimed_at=null, last_error=$3, updated_at=now()
     where job_id=$1 and url_hash=$2`,
    [jobId, urlHash, reason.slice(0, 500)],
  );
};

/**
 * Mark a row as owing a rendered fetch and return it to the pending pool.
 *
 * The HTTP pass already handled this URL, but its answer was judged incomplete, so the row
 * is reopened rather than left `handled`. `attempts` is deliberately not incremented: an
 * escalation is a change of fetcher, not a retry of a failure.
 */
export const escalateFrontierRequest = async (
  db: Pool,
  jobId: string,
  urlHash: string,
): Promise<boolean> => {
  const escalated = await db.query(
    `update frontier
     set state='pending', fetcher='browser', claimed_by=null, claimed_at=null,
         scheduled_for=now(), updated_at=now()
     where job_id=$1 and url_hash=$2 and fetcher<>'browser'`,
    [jobId, urlHash],
  );
  return (escalated.rowCount ?? 0) > 0;
};

/** How many rows of this job are waiting on a rendered fetch. */
export const countEscalatedFrontierRequests = async (db: Pool, jobId: string): Promise<number> => {
  const counts = await db.query<{ total: string }>(
    "select count(*)::text as total from frontier where job_id=$1 and fetcher='browser'",
    [jobId],
  );
  return Number(counts.rows[0]?.total ?? 0);
};

/** Return a claim to the pending pool, optionally after a delay, and count the attempt. */
export const reclaimFrontierRequest = async (
  db: Pool,
  jobId: string,
  urlHash: string,
  delaySeconds = 0,
): Promise<void> => {
  await db.query(
    `update frontier
     set state='pending', claimed_by=null, claimed_at=null, attempts=attempts+1,
         scheduled_for=now()+make_interval(secs=>$3), updated_at=now()
     where job_id=$1 and url_hash=$2`,
    [jobId, urlHash, Math.max(0, delaySeconds)],
  );
};

/**
 * Recover claims whose visibility timeout expired. A worker that was killed without
 * running its shutdown path leaves claims behind; this returns them so another replica
 * picks the work up instead of the job stalling.
 */
export const releaseExpiredFrontierClaims = async (
  db: Pool,
  visibilitySeconds: number,
): Promise<number> => {
  const released = await db.query(
    `update frontier
     set state='pending', claimed_by=null, claimed_at=null, updated_at=now()
     where state='claimed' and claimed_at < now()-make_interval(secs=>$1)`,
    [Math.max(1, visibilitySeconds)],
  );
  return released.rowCount ?? 0;
};

/**
 * Release every claim held by one worker. Graceful shutdown calls this so a deploy hands
 * work back immediately instead of waiting out the visibility timeout.
 */
export const releaseWorkerFrontierClaims = async (db: Pool, workerId: string): Promise<number> => {
  const released = await db.query(
    `update frontier
     set state='pending', claimed_by=null, claimed_at=null, updated_at=now()
     where state='claimed' and claimed_by=$1`,
    [workerId],
  );
  return released.rowCount ?? 0;
};

export const frontierCounts = async (db: Pool, jobId: string): Promise<FrontierCounts> => {
  const counts = await db.query<{ state: string; total: string }>(
    `select state, count(*)::text as total from frontier where job_id=$1 group by state`,
    [jobId],
  );
  const totals: FrontierCounts = { pending: 0, claimed: 0, handled: 0, failed: 0 };
  for (const row of counts.rows) {
    if (row.state in totals) totals[row.state as keyof FrontierCounts] = Number(row.total);
  }
  return totals;
};

/** True when at least one row is claimable right now. */
export const hasClaimableFrontierRequests = async (db: Pool, jobId: string): Promise<boolean> => {
  const due = await db.query(
    `select 1 from frontier
     where job_id=$1 and state='pending' and scheduled_for<=now() limit 1`,
    [jobId],
  );
  return (due.rowCount ?? 0) > 0;
};

/** True while any work remains: pending (due or scheduled) or claimed by some worker. */
export const hasUnfinishedFrontierRequests = async (db: Pool, jobId: string): Promise<boolean> => {
  const unfinished = await db.query(
    `select 1 from frontier where job_id=$1 and state in ('pending','claimed') limit 1`,
    [jobId],
  );
  return (unfinished.rowCount ?? 0) > 0;
};

/**
 * Bounded cleanup. The frontier is deleted when its job reaches a terminal state so the
 * table does not grow without limit; `jobs` cascades on delete for the same reason.
 */
export const deleteFrontier = async (db: Pool, jobId: string): Promise<number> => {
  const deleted = await db.query('delete from frontier where job_id=$1', [jobId]);
  return deleted.rowCount ?? 0;
};
