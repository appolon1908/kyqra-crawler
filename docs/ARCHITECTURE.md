# Kyqra Crawler target architecture

This is the target v2 architecture. It describes the destination of the
milestone program, not the capabilities of the current v1.1 application. The
acceptance ledger is the source of truth for which parts have been implemented
and proven.

## Plane model

```text
                        +--------------------------------------+
   clients --mTLS/TLS-->|  CONTROL PLANE                       |
                        |  Fastify API v2 - OpenAPI 3.1        |
                        |  RBAC - tenants - quotas - idempotency|
                        |  audit log - admin console            |
                        +--------------+-----------------------+
                                       |
                        +--------------v-----------------------+
                        |  COMPLIANCE PLANE          (BLOCKING)|
                        |  domain registry - legal status      |
                        |  robots.txt cache + evaluator        |
                        |  crawl-delay - PII policy - kill switch|
                        +--------------+-----------------------+
                                       |
                        +--------------v-----------------------+
                        |  SCHEDULING PLANE                    |
                        |  Redis frontier - per-host token     |
                        |  buckets - priority - budgets        |
                        |  URL dedup - content dedup (simhash) |
                        |  adaptive revisit scheduling        |
                        +--------------+-----------------------+
                                       |
              +------------------------+------------------------+
              v                        v                        v
   +----------------+      +--------------------+   +--------------------+
   | HTTP FETCHER   |      | BROWSER FETCHER    |   | SESSION MANAGER    |
   | undici - HTTP/2|      | Playwright pool    |   | credential vault   |
   | ETag/304 cache |      | context isolation  |   | login recipes      |
   | compression    |      | resource blocking  |   | cookie jars - TTL  |
   +-------+--------+      +---------+----------+   +---------+----------+
           |      ^ adaptive escalate|                        |
           +------+-------+----------+                        |
                          v                                   |
              +-----------------------+<----------------------+
              |  EGRESS MANAGER       |
              |  pools - health - SSRF|
              |  guard - circuit break|
              +-----------+-----------+
                          v
              +---------------------------------------+
              |  EXTRACTION PLANE                     |
              |  per-domain extractor packs           |
              |  -> JSON-LD/microdata/OpenGraph       |
              |  -> readability - table parser        |
              |  -> LLM-assist (schema-validated)     |
              |  schema registry - confidence         |
              |  field-level provenance - PII redact  |
              +-----------+---------------------------+
                          v
   +----------------------------------------------------------+
   |  STORAGE          Postgres (meta) - S3/MinIO (raw HTML,  |
   |                   screenshots, WARC) - OpenSearch (search)|
   +-----------+----------------------------------------------+
               v
   +----------------------------------------------------------+
   |  DELIVERY   batched signed webhooks - DLQ + replay       |
   |             S3 exports (CSV/JSONL/Parquet) - Kafka (opt) |
   +----------------------------------------------------------+

   CROSS-CUTTING: OpenTelemetry traces - Prometheus metrics -
   structured logs - per-domain SLOs - alerting - runbooks
```

The compliance plane is load-bearing: no scheduling, fetch, discovery,
authentication, or extraction path may bypass it.

## Target repository structure

```text
src/
  api/            routes/ (jobs, results, domains, sessions, admin, health)
                  middleware/ (auth, rbac, quota, ratelimit, audit)
                  openapi.ts
  compliance/     robots.ts  registry.ts  policy.ts  killswitch.ts
  frontier/       queue.ts  dedup.ts  budget.ts  tokenbucket.ts  revisit.ts
  fetch/          http.ts  browser.ts  adaptive.ts  egress.ts  cache.ts
  session/        vault.ts  recipes/  manager.ts  refresh.ts
  discovery/      sitemap.ts  search.ts  pagination.ts  siteforms.ts
  extract/        packs/  generic/  schema.ts  llm.ts  confidence.ts
                  provenance.ts  pii.ts
  storage/        postgres/ (repositories)  objects.ts  search-index.ts
  delivery/       webhooks.ts  dlq.ts  exports.ts
  observability/  otel.ts  metrics.ts  logger.ts
  workers/        crawl.ts  callback.ts  export.ts  maintenance.ts
  config/         env.ts  schema.ts
migrations/       0001_init.sql ... (forward + rollback)
test/
  unit/           pure logic, no I/O
  integration/    testcontainers: postgres + redis + minio
  e2e/            local fixture site (Express) - crawl -> extract -> deliver
  fixtures/       sites/ (static HTML, JS-rendered, paginated, login-walled)
  load/           k6 scripts
docs/             ARCHITECTURE.md ACCEPTANCE.md RUNBOOK.md THREAT_MODEL.md
                  COMPLIANCE.md API.md DR.md
```

## Data model (v2)

```text
tenants                id, name, plan, quota_pages_month, created_at
service_principals     id, tenant_id, key_sha256, roles[], enabled, rotated_at
domains                host PK, legal_status, robots_policy, crawl_delay_ms,
                       max_rps, requires_auth, extractor_pack, notes,
                       approved_by, approved_at
robots_cache           host, body, fetched_at, expires_at, parsed jsonb
jobs                   id, tenant_id, status, spec jsonb, budget jsonb,
                       progress jsonb, error, started_at, finished_at
job_requests           job_id, tenant_id, idempotency_key, request_hash,
                       correlation_id
frontier               job_id, url_hash, url, host, depth, priority, state,
                       attempts, scheduled_for, claimed_by, claimed_at
pages                  id, job_id, url, url_hash, http_status, content_hash,
                       simhash, fetched_at, fetcher, render_ms, bytes,
                       raw_object_key, screenshot_key
extractions            id, page_id, schema_id, data jsonb, confidence numeric,
                       provenance jsonb, extractor, extractor_version
schemas                id, name, version, json_schema jsonb, active
sessions               id, tenant_id, host, encrypted_state, expires_at,
                       last_refreshed_at, status
credentials            id, tenant_id, host, kms_key_id, ciphertext,
                       created_by, rotated_at
deliveries             id, job_id, target, payload_ref, attempts, status,
                       last_error, next_attempt_at
dead_letters           id, delivery_id, payload jsonb, reason, created_at
audit_log              id, tenant_id, principal_id, action, resource,
                       before jsonb, after jsonb, ip, at
```

## Authenticated crawling and site access

The platform will support authorized access through an encrypted credential
vault, tenant-isolated login recipes, reusable and revocable sessions, operator
MFA handoff, API keys, and OAuth 2.0 client credentials. Credential use remains
subject to domain approval and audit logging.

Discovery will support sitemaps, robots-declared sitemap indexes, site-internal
search, pagination, and approved external search APIs.

CAPTCHA solving, access-control circumvention, anti-bot fingerprint spoofing,
and proxy rotation intended to evade blocking are deliberately out of scope.
The crawler must identify itself, honor robots directives and `Retry-After`,
record per-domain legal approval, and expose a responsive kill switch.
