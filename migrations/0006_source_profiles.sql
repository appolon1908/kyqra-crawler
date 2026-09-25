-- Up Migration

CREATE TABLE source_profiles (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  profile jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, base_url)
);

CREATE INDEX source_profiles_tenant_created
  ON source_profiles (tenant_id, created_at DESC);

-- Down Migration

DROP INDEX source_profiles_tenant_created;
DROP TABLE source_profiles;
