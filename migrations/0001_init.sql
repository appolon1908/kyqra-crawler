-- Up Migration

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  status text,
  payload jsonb,
  progress jsonb DEFAULT '{}',
  error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS results (
  id bigserial PRIMARY KEY,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  url text,
  url_hash text,
  data jsonb,
  provenance jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (job_id, url_hash)
);

CREATE TABLE IF NOT EXISTS job_requests (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  correlation_id text NOT NULL,
  tenant_id text NOT NULL
);

ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE job_requests ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_requests DROP CONSTRAINT IF EXISTS job_requests_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS job_requests_tenant_idempotency
  ON job_requests (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS results_job ON results (job_id);

-- Down Migration

DROP TABLE IF EXISTS job_requests;
DROP TABLE IF EXISTS results;
DROP TABLE IF EXISTS jobs;
