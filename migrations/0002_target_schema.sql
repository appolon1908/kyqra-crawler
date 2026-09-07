-- Up Migration

CREATE TABLE tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL,
  quota_pages_month bigint NOT NULL CHECK (quota_pages_month >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name, plan, quota_pages_month)
SELECT DISTINCT tenant_id, tenant_id, 'legacy', 0
FROM job_requests
ON CONFLICT (id) DO NOTHING;

CREATE TABLE service_principals (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  key_sha256 text NOT NULL CHECK (length(key_sha256) = 64),
  roles text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  rotated_at timestamptz,
  UNIQUE (tenant_id, key_sha256)
);

CREATE TABLE domains (
  host text PRIMARY KEY,
  legal_status text NOT NULL,
  robots_policy text NOT NULL,
  crawl_delay_ms integer CHECK (crawl_delay_ms >= 0),
  max_rps numeric CHECK (max_rps > 0),
  requires_auth boolean NOT NULL DEFAULT false,
  extractor_pack text,
  notes text,
  approved_by bigint REFERENCES service_principals(id),
  approved_at timestamptz
);

CREATE TABLE robots_cache (
  host text PRIMARY KEY REFERENCES domains(host) ON DELETE CASCADE,
  body text NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  parsed jsonb NOT NULL
);

ALTER TABLE jobs RENAME COLUMN payload TO spec;
ALTER TABLE jobs
  ADD COLUMN tenant_id text,
  ADD COLUMN budget jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz;

UPDATE jobs
SET tenant_id = job_requests.tenant_id
FROM job_requests
WHERE job_requests.job_id = jobs.id;

CREATE INDEX jobs_tenant_status ON jobs (tenant_id, status);

CREATE TABLE frontier (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url_hash text NOT NULL,
  url text NOT NULL,
  host text NOT NULL,
  depth integer NOT NULL CHECK (depth >= 0),
  priority integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claimed_at timestamptz,
  PRIMARY KEY (job_id, url_hash)
);

CREATE INDEX frontier_claimable
  ON frontier (state, scheduled_for, priority DESC);
CREATE INDEX frontier_host_schedule
  ON frontier (host, scheduled_for);

CREATE TABLE pages (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url text NOT NULL,
  url_hash text NOT NULL,
  http_status integer,
  content_hash text,
  simhash text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  fetcher text NOT NULL,
  render_ms integer CHECK (render_ms >= 0),
  bytes bigint CHECK (bytes >= 0),
  raw_object_key text,
  screenshot_key text
);

CREATE INDEX pages_job_url ON pages (job_id, url_hash);
CREATE INDEX pages_content_hash ON pages (content_hash);

CREATE TABLE schemas (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  json_schema jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (name, version)
);

CREATE TABLE extractions (
  id bigserial PRIMARY KEY,
  page_id bigint NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  schema_id bigint REFERENCES schemas(id),
  data jsonb NOT NULL,
  confidence numeric CHECK (confidence >= 0 AND confidence <= 1),
  provenance jsonb NOT NULL,
  extractor text NOT NULL,
  extractor_version text NOT NULL
);

CREATE INDEX extractions_page ON extractions (page_id);

CREATE TABLE sessions (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  host text NOT NULL,
  encrypted_state bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  last_refreshed_at timestamptz,
  status text NOT NULL
);

CREATE INDEX sessions_tenant_host ON sessions (tenant_id, host);

CREATE TABLE credentials (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  host text NOT NULL,
  kms_key_id text NOT NULL,
  ciphertext bytea NOT NULL,
  created_by bigint REFERENCES service_principals(id),
  rotated_at timestamptz
);

CREATE INDEX credentials_tenant_host ON credentials (tenant_id, host);

CREATE TABLE deliveries (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  target text NOT NULL,
  payload_ref text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status text NOT NULL,
  last_error text,
  next_attempt_at timestamptz
);

CREATE INDEX deliveries_dispatchable
  ON deliveries (status, next_attempt_at);

CREATE TABLE dead_letters (
  id bigserial PRIMARY KEY,
  delivery_id bigint NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id bigint REFERENCES service_principals(id),
  action text NOT NULL,
  resource text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  ip inet,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_at ON audit_log (tenant_id, at DESC);

-- Down Migration

DROP TABLE audit_log;
DROP TABLE dead_letters;
DROP TABLE deliveries;
DROP TABLE credentials;
DROP TABLE sessions;
DROP TABLE extractions;
DROP TABLE schemas;
DROP TABLE pages;
DROP TABLE frontier;

DROP INDEX jobs_tenant_status;
ALTER TABLE jobs
  DROP COLUMN finished_at,
  DROP COLUMN started_at,
  DROP COLUMN budget,
  DROP COLUMN tenant_id;
ALTER TABLE jobs RENAME COLUMN spec TO payload;

DROP TABLE robots_cache;
DROP TABLE domains;
DROP TABLE service_principals;
DROP TABLE tenants;
