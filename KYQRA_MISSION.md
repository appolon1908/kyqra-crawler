# Kyqra production-hardening mission

This file records the milestone program that the `mission` labelled issues track, and
the exit criteria CI must prove before a milestone may be recorded in
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

The mission's authoritative scope lives in the GitHub milestones and their issues. This
file was reconstructed from that tracker in M3, because the M0 issue set referenced
`KYQRA_MISSION.md` as the home of the exit criteria but the file was never committed.
Milestones that have not started list their scope only; their exit criteria are the
acceptance checklists on their own issues.

## Rules

- A milestone is complete only when every exit criterion below passes in CI on a fresh
  checkout, at one commit, with no required job pending, skipped, or failing.
- The proving commit SHA and CI run are appended to `docs/ACCEPTANCE.md`. Branch names
  are not acceptable evidence.
- Capabilities that a milestone does not prove are stated under **Explicitly not
  claimed** in that ledger row. A milestone never claims a later milestone's work.
- M6, M14, and M15 additionally require recorded human approval.

## Milestones

| Milestone | Scope                                                     | Issues             | State    |
| --------- | --------------------------------------------------------- | ------------------ | -------- |
| M0        | Baseline truth reconciliation, defect inventory, ledger   | —                  | Complete |
| M1        | Replace source-string tests; restructure the service      | —                  | Complete |
| M2        | Reversible PostgreSQL migrations replace boot-time DDL    | #25                | Complete |
| M3        | Crawl-target SSRF, robots.txt, and probe-surface controls | #9, #10, #30       | Complete |
| M4        | Durable frontier, real cancellation, graceful shutdown    | #15, #16, #17, #21 | Complete |
| M5        | Adaptive `browser=auto` escalation                        | #14                | Planned  |
| M6        | Tenant-isolated authenticated crawling                    | #23                | Planned  |
| M7        | Sitemap, pagination, and compliant search discovery       | #13, #22           | Planned  |
| M8        | Extraction packs and real field-level provenance          | #12, #18, #24      | Planned  |
| M9        | Delivery batching, dead-letter queue, and replay          | #19, #20           | Planned  |
| M10       | Metrics, tracing, and a generated OpenAPI contract        | #26                | Planned  |
| M11       | API rate limiting, mutation audit logs, dashboard hygiene | #11, #26, #27      | Planned  |
| M12–M15   | Reserved for cutover, canary, and production activation   | —                  | Planned  |

## M5 exit criteria

`browser=auto` resolved to the HTTP crawler and never rendered, so a JavaScript-built page
completed successfully with empty extraction — a silent wrong answer rather than a visible
failure.

1. A page fetched over HTTP is judged render-dependent from what it actually returned: an
   empty framework mount point, a `<noscript>` prompt with no extracted content, or a
   script-dominated shell carrying almost no text.
2. A page that delivered its content is left on the HTTP fetcher. A thin page with no
   script, and a mount point the server already filled, are not escalations.
3. An escalated job is handed to the browser worker, which is the container provisioned
   with the shared memory a browser needs. The HTTP worker never launches one.
4. Escalation reuses the M4 durable frontier: rows judged render-dependent are reopened and
   marked as owing a rendered fetch, everything already handled stays handled, and the
   browser pass resumes from the same frontier.
5. An escalation is not a failure. The job stays runnable, keeps its frontier, and is not
   recorded as failed.
6. Every result records which fetcher produced it, and a rendered result supersedes the
   HTTP one for the same URL. The reverse never happens.
7. The deciding signal is persisted as evidence, so an escalation is answerable after the
   fact rather than a black box.
8. `GET /api/v1/jobs/{id}/results` reports the fetcher per row and a per-fetcher summary,
   and the CSV export carries the same column.

### Evidence

9. All CI jobs pass on a fresh checkout at the proving commit.
10. `docs/ACCEPTANCE.md` gains an M5 row linking the proving commit and CI run, and states
    what M5 does not claim — in particular that CI installs no browser, so the rendered
    fetch itself is not exercised there.

## M4 exit criteria

M4 replaces the parts of the crawl loop that assumed a single, never-replaced worker: a
frontier on local disk, cancellation that only took effect between requests, no shutdown
path, and pacing that each replica applied on its own.

### Durable frontier (#17)

1. The crawl frontier is the `frontier` table in PostgreSQL. Crawlee is driven through a
   request manager backed by it, and no request queue is written to a worker filesystem.
2. Claims are rows with an owner and a timestamp, taken with `for update skip locked`, so
   replicas claim disjoint work from one frontier without blocking each other.
3. A URL discovered twice is stored once, and work already handled is never handed out
   again, including across a restart.
4. A claim whose visibility timeout expires returns to the pending pool automatically, so
   a killed replica does not strand a job.
5. The frontier is deleted when its job reaches a terminal state, and cascades with the
   job, so the table does not grow without bound.
6. The job page budget is enforced against the shared frontier, not only per crawler
   instance.

### Cancellation (#15)

7. Cancelling a job reaches a worker that is already running it, over Redis and confirmed
   by a database poll, and all fetching stops within five seconds.
8. The cancellation aborts in-flight fetches and rate-limiter waits rather than waiting
   for the request handler timeout.
9. A cancelled job stays cancelled: it is not subsequently recorded as failed or
   completed, and no further results are written.

### Graceful shutdown and resumable claims (#16)

10. SIGTERM and SIGINT start an ordered shutdown: stop claiming, let in-flight work
    settle, release this worker's frontier claims, then close connections, bounded by a
    grace period after which the process exits regardless.
11. An interrupted job is not marked failed; it keeps its frontier and resumes on the
    next attempt, on this replica or another.
12. Resumption loses no work and duplicates no fetch.

### Shared per-host rate limits (#21)

13. Pacing is a Redis token bucket keyed by host, so every replica draws from one budget
    instead of applying a per-crawler delay.
14. The bucket rate is the most restrictive of the job's requested rate, the robots.txt
    `Crawl-delay`, and the operator-approved `domains` row.
15. `Retry-After` on 429 and 503 is honored before the next request to that host.
16. Repeated failures reduce the host's rate adaptively, down to a floor, and recover on
    success; a host that keeps failing has its circuit opened for a cooling-off window.

### Evidence

17. All CI jobs pass on a fresh checkout at the proving commit.
18. `docs/ACCEPTANCE.md` gains an M4 row linking the proving commit and CI run, and
    states what M4 does not claim.

## M3 exit criteria

M3 closes the three defects that let a crawl reach a prohibited destination, ignore a
host's stated crawl policy, or drive backing-store probes from the public internet.

### Crawl-target SSRF (#9)

1. Seed URLs are rejected before any network fetch when they are not `http(s)`, carry
   embedded credentials, name a denied or non-allowlisted host, or resolve to a
   private, loopback, link-local, or cloud-metadata address.
2. Discovered links pass the same policy before they are enqueued and again before they
   are fetched.
3. DNS answers are pinned for the life of a request, and a hostname whose address set
   changes mid-job is rejected as rebinding.
4. Every redirect hop is revalidated against the policy before the connection is made,
   on both the HTTP and browser paths.

### robots.txt enforcement (#10)

5. `robots.txt` is fetched through the same pinned-address policy as crawl targets, and
   cached per origin with a bounded TTL and a bounded body size.
6. `Allow`, `Disallow`, `Crawl-delay`, and `Sitemap` are parsed, with most-specific-rule
   precedence, `Allow` breaking ties, `*` and `$` pattern support, and per-user-agent
   group selection.
7. No disallowed URL is enqueued — seeds or discovered links — and a job whose every
   seed is disallowed fails with `robots_disallowed_all_seeds` rather than reporting a
   successful empty crawl.
8. A declared `Crawl-delay` raises the per-host delay when it exceeds the job's
   configured rate, and is capped so a hostile host cannot stall a worker.
9. An origin whose `robots.txt` is unreachable (5xx or transport failure) is not
   crawled; a 4xx is treated as "no restrictions", per RFC 9309.

### Public probe surface (#30)

10. `/healthz` remains the public shallow liveness probe and executes no dependency
    probe.
11. `/health`, `/readyz`, and `/health/ready` execute Redis and PostgreSQL probes and
    are served only to authenticated callers on the public listener, or without
    authentication on an internal listener that is never published or proxied.
12. The Nginx public route policy returns 404 for every deep probe, and container
    health checks and the privileged installer use the internal listener.
13. Behavioral tests prove an unauthenticated public caller cannot cause a Redis `PING`
    or a PostgreSQL query.

### Evidence

14. All CI jobs pass on a fresh checkout at the proving commit, including the image
    exercise that records the public and internal probe status codes.
15. `docs/ACCEPTANCE.md` gains an M3 row linking the proving commit and CI run, and
    states what M3 does not claim.
