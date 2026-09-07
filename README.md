# Kyqra Crawler

Production crawler service for `https://crawler.kyqra.com`.

## Production architecture

Nginx TLS terminates the public connection and proxies to the loopback-only Fastify API. The API
persists tenant-scoped jobs and idempotency records in PostgreSQL, then routes HTTP and Playwright
jobs to separate durable BullMQ queues in authenticated Redis. Dedicated callback workers deliver
allowlisted, signed events to the private integration gateway.

The four application roles use one reviewed image digest:

- `ROLE=api`
- `ROLE=worker`, `WORKER_KIND=http`
- `ROLE=worker`, `WORKER_KIND=browser`
- `ROLE=callback`

The image must be deployed by immutable `@sha256` reference. The image carries the exact 40-character
Git revision in `org.opencontainers.image.revision` and `SOURCE_SHA`.

## Authentication and tenant boundary

All non-public routes require `Authorization: Bearer <token>`. Tokens are never stored directly in
the service-principal registry: only lowercase SHA-256 digests are accepted and comparisons are
constant-time. A principal has exactly one tenant and client identity. If supplied, `X-Tenant-Id`
must match that identity. Operational routes additionally require the `operations` role.

Public routes are limited to the dashboard and health/contract discovery:

- `GET /`
- `GET /health`, `/healthz`, `/readyz`
- `GET /health/live`, `/health/ready`
- `GET /api/v1/health`
- `GET /openapi.json`

Canonical authenticated routes:

- `GET /api/v1/me`
- `GET /api/v1/capabilities`
- `POST /api/v1/jobs`
- `GET /api/v1/jobs`
- `GET /api/v1/jobs/{id}`
- `GET /api/v1/jobs/{id}/results`
- `GET /api/v1/jobs/{id}/events`
- `POST /api/v1/jobs/{id}/cancel`
- `POST /api/v1/jobs/{id}/retry`
- `GET /api/v1/operations`
- `GET /api/v1/operations/{id}`
- `GET /api/v1/operations/{id}/events`
- `GET /api/v1/operations/{id}/attempts`
- `POST /api/v1/operations/{id}/cancel`
- `POST /api/v1/operations/{id}/reconcile`
- `GET /api/v1/stats` (`operations` role)
- `POST /api/v1/webhooks/test` (`operations` role)
- `GET /metrics` (`operations` role)

There is no alternate `/v1` API. `openapi.json` is the canonical machine-readable contract and is
validated in CI against a checksum-pinned official OpenAPI 3.1 validation schema.

## Durable command behavior

Every externally effective `POST` requires `Idempotency-Key` and `X-Correlation-Id`, each 8–128
characters. Idempotency identity includes tenant, caller, action, API version, resource, key, and
canonical semantic payload.

- Same identity and semantics returns the original durable response.
- Same identity with different semantics returns `409`.
- A reserved command without a recorded outcome returns `409 command_outcome_ambiguous` with
  `reconciliation_required=true`.

Jobs expose durable `QUEUED`, `PROCESSING`, `SUCCEEDED`, `FAILED`, and `CANCELLED` operation states.
Cancellation is terminal: an in-flight fetch cannot persist a late result or completion callback.
Automatic and explicit retries use isolated per-attempt crawl frontiers.

## Crawl safety

Before enqueueing and before every navigation, Kyqra enforces:

- HTTP/HTTPS only and no URL credentials
- loopback, private, link-local, documentation, multicast, and cloud-metadata IP denial
- local/internal hostname denial
- optional hostname allowlist and denylist
- DNS result pinning and per-job rebinding detection
- redirect destination revalidation
- Playwright subresource interception
- maximum pages, depth, request rate, body size, and request timeouts

`KYQRA_ALLOW_TEST_TARGETS=true` exists only for isolated tests and must never be present in production.
`browser=auto` currently routes to the HTTP worker; request `browser=playwright` explicitly when a
rendered browser is required.

## Secrets and configuration

Production secret values do not belong in Git or Compose environment variables. Compose mounts
root-controlled files for:

- service-principal digest registry
- Redis password
- PostgreSQL password
- private-gateway bearer credential
- callback HMAC key

See `.env.example` for the host-side file-path variables. Callback credentials and database/Redis
passwords are validated at startup; a missing, weak, or conflicting direct/file source fails closed.
OpenBao integration remains the intended long-term delivery mechanism, but deployment must not claim
it until the production authority is initialized and its service authentication is approved.

## Development and certification

```bash
npm ci
npm run format-check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:policy
npm run test:release-signing
npm run test:coverage
./scripts/validate-compose.sh
```

Integration tests use isolated PostgreSQL, Redis, and a deterministic loopback fixture. They exercise
authentication, tenant denial, rate/input checks, semantic idempotency, a real HTTP crawl, read-back,
durable events, cancellation races, retry, and migration up/down/adoption. They never crawl a public
customer target.

## Deployment

The production publication workflow accepts only the protected `main` branch at the exact triggering
SHA. It builds with source provenance, scans the exact digest, prevents immutable-tag collisions,
signs and attests the candidate through GitHub OIDC, verifies those attestations, and only then creates
the immutable source tag.

Before cutover:

1. Confirm the old `crawl` queue has no active, waiting, delayed, or failed production work requiring
   recovery. The new release uses `crawl-http` and `crawl-browser`.
2. Take and verify isolated PostgreSQL and Redis backups.
3. Record the current image IDs/digests and rendered Compose configuration.
4. Run the one-shot migration service.
5. Start API, HTTP worker, browser worker, and callback worker on the approved digest.
6. Validate unauthenticated denial, authenticated identity, one approved test crawl, callback receipt,
   metrics, restart persistence, and exact digest read-back.

Rollback must use the recorded prior digest and configuration. Schema rollback is version-sensitive:
stop application writers, take another backup, validate compatibility, and run the explicit down
migration only when the prior application requires it. Never roll back over live writes blindly.

## Backup and restore

PostgreSQL and Redis use named persistent volumes. A backup is not certified merely because a file
exists: production requires an encrypted off-host copy plus a successful restore into isolated
temporary PostgreSQL and Redis targets. Do not restore over the live databases during certification.

Local backup scripts and retention are supporting mechanisms only; the production report must record
the exact backup artifact, checksum, off-host destination, isolated restore result, and rollback
artifact identity.
