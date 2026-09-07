import type { Pool, PoolClient } from 'pg';

import type { JobSpec } from '../../config/schema.js';
import type { ExtractionData } from '../../extract/generic.js';

export interface JobMetadata {
  correlation_id: string;
  tenant_id: string;
}

export interface CallbackResultRow {
  id: string;
  data: ExtractionData;
  provenance: Record<string, string>;
}

export interface IdempotentJob {
  job_id: string;
  request_hash: string;
  correlation_id: string;
  enqueue_outcome: 'PENDING' | 'QUEUED' | 'FAILED';
  status: string;
  error: string | null;
}

export interface JobStatusRow {
  id: string;
  status: string;
  progress: Record<string, unknown>;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  correlation_id: string;
}

export interface InternalJobState {
  status: string;
  progress: Record<string, unknown>;
}

export interface JobResultRow {
  data: ExtractionData;
  provenance: Record<string, string>;
}

export interface CommandRequestRow {
  id: string;
  request_hash: string;
  correlation_id: string;
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  response_code: number | null;
  response: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export const checkPostgresReady = async (db: Pool): Promise<void> => {
  await db.query('select tenant_id,spec,budget from jobs limit 0');
  await db.query('select tenant_id,event_type,status from job_events limit 0');
  await db.query('select tenant_id,caller_id,enqueue_outcome from job_requests limit 0');
  await db.query('select tenant_id,caller_id,action,status from command_requests limit 0');
};

export const getInternalJobStatus = async (db: Pool, jobId: string): Promise<string | null> => {
  const result = await db.query<{ status: string }>('select status from jobs where id=$1', [jobId]);
  return result.rows[0]?.status ?? null;
};

export const getInternalJobState = async (
  db: Pool,
  jobId: string,
): Promise<InternalJobState | null> => {
  const result = await db.query<InternalJobState>(
    'select status,progress from jobs where id=$1',
    [jobId],
  );
  return result.rows[0] ?? null;
};

export const countJobResults = async (db: Pool, jobId: string): Promise<number> => {
  const result = await db.query<{ count: number }>(
    'select count(*)::integer as count from results where job_id=$1',
    [jobId],
  );
  return result.rows[0]?.count ?? 0;
};

export const markJobRunning = async (db: Pool, jobId: string): Promise<boolean> => {
  const result = await db.query(
    `with claimed as (
       update jobs
          set status='running',started_at=coalesce(started_at,now()),updated_at=now()
        where id=$1 and status in ('queued','running')
        returning id,tenant_id
     )
     insert into job_events(job_id,tenant_id,event_type,status,payload)
     select id,tenant_id,'job.running','running','{}'::jsonb from claimed
     returning job_id`,
    [jobId],
  );
  return (result.rowCount ?? 0) === 1;
};

export const insertResult = async (
  db: Pool,
  jobId: string,
  url: string,
  urlHash: string,
  data: ExtractionData,
  provenance: Record<string, string>,
): Promise<number> => {
  const result = await db.query(
    `with runnable as (
       select id from jobs where id=$1 and status='running' for update
     )
     insert into results(job_id,url,url_hash,data,provenance)
     select id,$2,$3,$4,$5 from runnable
     on conflict do nothing returning id`,
    [jobId, url, urlHash, data, provenance],
  );
  return result.rowCount ?? 0;
};

export const markJobCompleted = async (
  db: Pool,
  jobId: string,
  progress: { processed: number; records: number; failed: number },
): Promise<boolean> => {
  await db.query("select set_job_status($1,'completed',$2)", [jobId, JSON.stringify(progress)]);
  return (await getInternalJobStatus(db, jobId)) === 'completed';
};

export const getJobMetadata = async (db: Pool, jobId: string): Promise<JobMetadata | null> => {
  const result = await db.query<JobMetadata>(
    'select correlation_id,tenant_id from job_requests where job_id=$1',
    [jobId],
  );
  return result.rows[0] ?? null;
};

export const listResultsForCallbacks = async (
  db: Pool,
  jobId: string,
): Promise<CallbackResultRow[]> => {
  const result = await db.query<CallbackResultRow>(
    'select id::text,data,provenance from results where job_id=$1 order by id',
    [jobId],
  );
  return result.rows;
};

export const markJobFailed = async (db: Pool, jobId: string, error: string): Promise<void> => {
  await db.query("select set_job_status($1,'failed',$2)", [jobId, error.slice(0, 2000)]);
};

export const findIdempotentJob = async (
  db: Pool,
  tenantId: string,
  callerId: string,
  idempotencyKey: string,
): Promise<IdempotentJob | null> => {
  const result = await db.query<IdempotentJob>(
    `select m.job_id,m.request_hash,m.correlation_id,m.enqueue_outcome,j.status,j.error
       from job_requests m join jobs j on j.id=m.job_id
      where m.tenant_id=$1 and m.caller_id=$2 and m.action='crawl.job.create'
        and m.api_version='api/v1' and m.resource='jobs' and m.idempotency_key=$3`,
    [tenantId, callerId, idempotencyKey],
  );
  return result.rows[0] ?? null;
};

export const recordJobEnqueueOutcome = async (
  db: Pool,
  jobId: string,
  outcome: 'QUEUED' | 'FAILED',
): Promise<void> => {
  const result = await db.query(
    `update job_requests set enqueue_outcome=$2
      where job_id=$1 and enqueue_outcome in ('PENDING',$2) returning job_id`,
    [jobId, outcome],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error('enqueue_outcome_not_recorded');
};

const insertJobTransaction = async (
  client: PoolClient,
  jobId: string,
  payload: JobSpec,
  idempotencyKey: string,
  requestHash: string,
  correlationId: string,
  tenantId: string,
  callerId: string,
): Promise<void> => {
  await client.query('begin');
  try {
    await client.query("insert into jobs(id,tenant_id,status,spec) values($1,$2,'queued',$3)", [
      jobId,
      tenantId,
      payload,
    ]);
    await client.query(
      `insert into job_requests(
         job_id,idempotency_key,request_hash,correlation_id,tenant_id,
         caller_id,action,api_version,resource,enqueue_outcome
       ) values($1,$2,$3,$4,$5,$6,'crawl.job.create','api/v1','jobs','PENDING')`,
      [jobId, idempotencyKey, requestHash, correlationId, tenantId, callerId],
    );
    await client.query(
      "insert into job_events(job_id,tenant_id,event_type,status,payload) values($1,$2,'job.queued','queued',$3)",
      [jobId, tenantId, { correlation_id: correlationId }],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  }
};

export const createJob = async (
  db: Pool,
  jobId: string,
  payload: JobSpec,
  idempotencyKey: string,
  requestHash: string,
  correlationId: string,
  tenantId: string,
  callerId: string,
): Promise<void> => {
  const client = await db.connect();
  try {
    await insertJobTransaction(
      client,
      jobId,
      payload,
      idempotencyKey,
      requestHash,
      correlationId,
      tenantId,
      callerId,
    );
  } finally {
    client.release();
  }
};

export const getJobStatus = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<JobStatusRow | null> => {
  const result = await db.query<JobStatusRow>(
    'select j.id,j.status,j.progress,j.error,j.created_at,j.updated_at,m.correlation_id from jobs j join job_requests m on m.job_id=j.id where j.id=$1 and m.tenant_id=$2',
    [jobId, tenantId],
  );
  return result.rows[0] ?? null;
};

export const getJobResults = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<{ correlationId: string; rows: JobResultRow[] } | null> => {
  const metadata = await db.query<{ correlation_id: string }>(
    'select correlation_id from job_requests where job_id=$1 and tenant_id=$2',
    [jobId, tenantId],
  );
  const correlationId = metadata.rows[0]?.correlation_id;
  if (!correlationId) return null;
  const results = await db.query<JobResultRow>(
    'select r.data,r.provenance from results r join job_requests m on m.job_id=r.job_id where r.job_id=$1 and m.tenant_id=$2 order by r.id',
    [jobId, tenantId],
  );
  return { correlationId, rows: results.rows };
};

export const ownsJob = async (db: Pool, jobId: string, tenantId: string): Promise<boolean> => {
  const result = await db.query('select 1 from job_requests where job_id=$1 and tenant_id=$2', [
    jobId,
    tenantId,
  ]);
  return (result.rowCount ?? 0) > 0;
};

export const cancelJob = async (db: Pool, jobId: string, tenantId: string): Promise<boolean> => {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update jobs j set status='cancelled',finished_at=now(),updated_at=now()
         from job_requests m
        where j.id=$1 and m.job_id=j.id and m.tenant_id=$2
          and j.status in ('queued','running') returning j.id`,
      [jobId, tenantId],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('rollback');
      return false;
    }
    await client.query(
      "insert into job_events(job_id,tenant_id,event_type,status,payload) values($1,$2,'job.cancelled','cancelled','{}')",
      [jobId, tenantId],
    );
    await client.query('commit');
    return true;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

export const getJobPayload = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<JobSpec | null> => {
  const result = await db.query<{ payload: JobSpec }>(
    'select j.spec as payload from jobs j join job_requests m on m.job_id=j.id where j.id=$1 and m.tenant_id=$2',
    [jobId, tenantId],
  );
  return result.rows[0]?.payload ?? null;
};

export const resetJobQueued = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<boolean> => {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update jobs set status='queued',error=null,started_at=null,finished_at=null,updated_at=now()
        where id=$1 and tenant_id=$2 and status in ('failed','cancelled') returning id`,
      [jobId, tenantId],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('rollback');
      return false;
    }
    await client.query(
      "insert into job_events(job_id,tenant_id,event_type,status,payload) values($1,$2,'job.queued','queued','{}')",
      [jobId, tenantId],
    );
    await client.query('commit');
    return true;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

export const listJobs = async (
  db: Pool,
  tenantId: string,
  limit: number,
): Promise<JobStatusRow[]> => {
  const result = await db.query<JobStatusRow>(
    `select j.id,j.status,j.progress,j.error,j.created_at,j.updated_at,m.correlation_id
       from jobs j join job_requests m on m.job_id=j.id
      where m.tenant_id=$1 order by j.created_at desc limit $2`,
    [tenantId, limit],
  );
  return result.rows;
};

export const getJobEvents = async (db: Pool, jobId: string, tenantId: string) => {
  const result = await db.query(
    `select id::text,event_type,status,payload,created_at
       from job_events where job_id=$1 and tenant_id=$2 order by id`,
    [jobId, tenantId],
  );
  return result.rows;
};

export const beginCommand = async (
  db: Pool,
  values: {
    id: string;
    tenantId: string;
    callerId: string;
    action: string;
    resource: string;
    idempotencyKey: string;
    requestHash: string;
    correlationId: string;
  },
): Promise<{ row: CommandRequestRow; duplicate: boolean }> => {
  const inserted = await db.query<CommandRequestRow>(
    `insert into command_requests(
       id,tenant_id,caller_id,action,api_version,resource,idempotency_key,
       request_hash,correlation_id,status
     ) values($1,$2,$3,$4,'api/v1',$5,$6,$7,$8,'PROCESSING')
     on conflict (tenant_id,caller_id,action,api_version,resource,idempotency_key)
     do nothing
     returning id,request_hash,correlation_id,status,response_code,response,created_at,updated_at`,
    [
      values.id,
      values.tenantId,
      values.callerId,
      values.action,
      values.resource,
      values.idempotencyKey,
      values.requestHash,
      values.correlationId,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { row: created, duplicate: false };
  const prior = await db.query<CommandRequestRow>(
    `select id,request_hash,correlation_id,status,response_code,response,created_at,updated_at
       from command_requests
      where tenant_id=$1 and caller_id=$2 and action=$3 and api_version='api/v1'
        and resource=$4 and idempotency_key=$5`,
    [
      values.tenantId,
      values.callerId,
      values.action,
      values.resource,
      values.idempotencyKey,
    ],
  );
  const existing = prior.rows[0];
  if (!existing) throw new Error('idempotency_readback_failed');
  if (existing.request_hash !== values.requestHash) throw new Error('idempotency_conflict');
  return { row: existing, duplicate: true };
};

export const completeCommand = async (
  db: Pool,
  commandId: string,
  responseCode: number,
  response: Record<string, unknown>,
): Promise<void> => {
  const status = responseCode >= 200 && responseCode < 400 ? 'SUCCEEDED' : 'FAILED';
  const result = await db.query(
    `update command_requests
        set status=$2,response_code=$3,response=$4,updated_at=now()
      where id=$1 and status='PROCESSING'`,
    [commandId, status, responseCode, response],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error('command_completion_conflict');
};
