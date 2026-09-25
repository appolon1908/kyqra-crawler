# Kyqra Crawler

> **Canonical crawler authority:** `ingtrader21-spec/kyqra-crawler`.
>
> The older `appolon1908-hue/kyqra` repository is legacy/historical source and must not
> become a competing crawler API, queue, credential set, job ledger or production runtime.

Production crawler service for `https://crawler.kyqra.com`.

## Codestra integration boundary

```text
Client / n8n
    |
    v
Kong -> Middleware -> Kyqra Crawler
                         |
                         +-> signed result callback -> Middleware -> Odoo/n8n as authorized
```

Middleware is the cross-system control/write authority. Kyqra Crawler owns crawl-job
execution and crawl-result truth; it does not write directly to Odoo or other Codestra
product databases. Runtime activation and unrestricted crawling remain separate reviewed
gates.

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

Public routes are limited to the dashboard, shallow liveness, and contract discovery:

- `GET /`
- `GET /healthz`, `/health/live`, `/api/v1/health`
- `GET /openapi.json`

`GET /health`, `GET /readyz`, and `GET /health/ready` run Redis and PostgreSQL probes.
On the public listener they require a bearer token; the Nginx public policy returns 404
for all three. They are also served without authentication on an internal listener
(`INTERNAL_HEALTH_HOST`/`INTERNAL_HEALTH_PORT`, default `127.0.0.1:3001`) that compose
never publishes, which is what container health checks and the installer use.

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

### robots.txt

`robots.txt` is fetched for every seed origin through the same pinned-address policy as
crawl targets, before the frontier is populated, and cached per origin
(`ROBOTS_CACHE_TTL_SECONDS`, default one hour). `Allow`, `Disallow`, `Crawl-delay`, and
`Sitemap` are parsed with most-specific-rule precedence, `Allow` breaking ties, `*` and
`$` patterns, and per-user-agent group selection (`ROBOTS_USER_AGENT`, default
`KyqraCrawler`).

No disallowed URL is enqueued, as a seed or as a discovered link, and the decision is
rechecked before each navigation. A job whose every seed is disallowed fails with
`robots_disallowed_all_seeds` instead of reporting an empty successful crawl. A declared
`Crawl-delay` raises the per-host delay when it exceeds the job's configured rate, capped
by `ROBOTS_MAX_CRAWL_DELAY_SECONDS` (default 30) so a hostile host cannot stall a worker.
Following RFC 9309, an origin whose `robots.txt` is unreachable (5xx or transport
failure) is not crawled, while a 4xx is treated as "no restrictions". Declared sitemaps
are recorded; sitemap-driven discovery is M7.

`KYQRA_ALLOW_TEST_TARGETS=true` exists only for isolated tests and must never be present in production.

### Fetcher selection

`browser=http` and `browser=playwright` pick a fetcher outright. `browser=auto` starts on the
HTTP worker and escalates only when a page proves it needs rendering: an empty framework mount
point, a `<noscript>` prompt on a page with no extracted content, or a script-dominated shell
with almost no text. A page that delivered its content stays on HTTP, and so does a thin page
that carries no script.

An escalated job is handed to the browser worker rather than rendered in place, because that is
the container provisioned with the shared memory a browser needs. It reuses the durable frontier:
rows judged render-dependent are reopened and marked as owing a rendered fetch, work already done
stays done, and the browser pass resumes from the same frontier. An escalation is not a failure —
the job stays runnable throughout.

Every result records its fetcher, and a rendered result supersedes the HTTP one for the same URL;
the reverse never happens. `GET /api/v1/jobs/{id}/results` reports the fetcher per row plus a
per-fetcher summary, the CSV export carries the same column, and the deciding signal is written to
the job event timeline so an escalation can be explained after the fact.

## Frontier, pacing, and lifecycle

The crawl frontier is the `frontier` table in PostgreSQL, not a directory on one worker.
Crawlee is driven through a request manager backed by that table, so nothing is written to
a worker filesystem. A worker claims rows with `for update skip locked`, recording its
identity and the time, which lets replicas take disjoint work from the same frontier. A URL
discovered twice is stored once, work already handled is never reissued, and the frontier is
deleted when its job reaches a terminal state.

A claim that goes quiet for `FRONTIER_VISIBILITY_SECONDS` returns to the pending pool, swept
every `FRONTIER_SWEEP_SECONDS`, so a replica killed outright cannot strand a job.

Cancelling a job reaches a worker that is already running it: the API publishes on Redis and
every worker also polls the job row, so fetching stops within seconds rather than at the next
request boundary. In-flight fetches and rate-limiter waits are aborted, and a cancelled job is
never later recorded as failed or completed.

SIGTERM starts an ordered shutdown — stop claiming, let in-flight work settle, release this
worker's claims, close connections — bounded by `SHUTDOWN_GRACE_SECONDS`. An interrupted job
is not marked failed; it keeps its frontier and resumes on the next attempt without losing or
repeating work.

Per-host pacing is a Redis token bucket, so replicas share one budget for a host instead of
each applying its own delay. The rate is the most restrictive of the job's `requestsPerSecond`,
the robots.txt `Crawl-delay`, and the host's `domains` row. `Retry-After` on 429 and 503 is
honored, repeated failures reduce the rate adaptively down to a floor and recover on success,
and a host that keeps failing has its circuit opened for a cooling-off window.

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
