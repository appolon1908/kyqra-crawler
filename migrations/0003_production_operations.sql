-- Up Migration

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_events_tenant_job ON job_events (tenant_id, job_id, id);

ALTER TABLE job_requests
  ADD COLUMN caller_id text NOT NULL DEFAULT 'legacy',
  ADD COLUMN action text NOT NULL DEFAULT 'crawl.job.create',
  ADD COLUMN api_version text NOT NULL DEFAULT 'api/v1',
  ADD COLUMN resource text NOT NULL DEFAULT 'jobs',
  ADD COLUMN enqueue_outcome text NOT NULL DEFAULT 'QUEUED'
    CHECK (enqueue_outcome IN ('PENDING','QUEUED','FAILED'));

DROP INDEX job_requests_tenant_idempotency;
CREATE UNIQUE INDEX job_requests_semantic_idempotency ON job_requests
  (tenant_id, caller_id, action, api_version, resource, idempotency_key);

CREATE TABLE command_requests (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  caller_id text NOT NULL,
  action text NOT NULL,
  api_version text NOT NULL,
  resource text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  correlation_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PROCESSING','SUCCEEDED','FAILED')),
  response_code integer CHECK (response_code BETWEEN 200 AND 599),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, caller_id, action, api_version, resource, idempotency_key)
);

CREATE INDEX command_requests_tenant_created ON command_requests (tenant_id, created_at DESC);

ALTER TABLE jobs ADD CONSTRAINT jobs_status_allowed
  CHECK (status IN ('queued','running','completed','failed','cancelled')) NOT VALID;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_status_allowed;

CREATE FUNCTION set_job_status(target_job uuid, target_status text, detail text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE target_tenant text;
BEGIN
  UPDATE jobs
     SET status=target_status,
         progress=CASE WHEN target_status='completed' AND detail IS NOT NULL THEN detail::jsonb ELSE progress END,
         error=CASE WHEN target_status='failed' THEN detail ELSE error END,
         started_at=CASE WHEN target_status='running' THEN coalesce(started_at,now()) ELSE started_at END,
         finished_at=CASE WHEN target_status IN ('completed','failed') THEN now() ELSE finished_at END,
         updated_at=now()
   WHERE id=target_job
     AND ((target_status='running' AND status='queued')
       OR (target_status='completed' AND status='running')
       OR (target_status='failed' AND status IN ('queued','running')))
   RETURNING tenant_id INTO target_tenant;
  IF target_tenant IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM jobs WHERE id=target_job) THEN
      RAISE EXCEPTION 'job_not_found';
    END IF;
    RETURN;
  END IF;
  INSERT INTO job_events(job_id,tenant_id,event_type,status,payload)
  VALUES(target_job,target_tenant,'job.' || target_status,target_status,
         CASE WHEN detail IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('detail',detail) END);
END $$;

-- Down Migration

DROP FUNCTION set_job_status(uuid,text,text);
ALTER TABLE jobs DROP CONSTRAINT jobs_status_allowed;
DROP TABLE command_requests;
DROP INDEX job_requests_semantic_idempotency;
WITH ranked AS (
  SELECT job_id,row_number() OVER (
    PARTITION BY tenant_id,idempotency_key
    ORDER BY CASE WHEN caller_id='legacy' THEN 0 ELSE 1 END,job_id
  ) AS ordinal
  FROM job_requests
), maximum_key AS (
  SELECT COALESCE(max(char_length(idempotency_key)),0)+1 AS pad_length
  FROM job_requests
), replacements AS (
  SELECT ranked.job_id,repeat('r',maximum_key.pad_length) || ':' || ranked.job_id::text AS replacement
  FROM ranked CROSS JOIN maximum_key
  WHERE ranked.ordinal > 1
)
UPDATE job_requests AS request
   SET idempotency_key=replacements.replacement
  FROM replacements
 WHERE request.job_id=replacements.job_id;
ALTER TABLE job_requests
  DROP COLUMN enqueue_outcome,
  DROP COLUMN resource,
  DROP COLUMN api_version,
  DROP COLUMN action,
  DROP COLUMN caller_id;
CREATE UNIQUE INDEX job_requests_tenant_idempotency
  ON job_requests (tenant_id, idempotency_key);
DROP TABLE job_events;
