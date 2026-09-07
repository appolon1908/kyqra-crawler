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

| Milestone | Scope                                                     | Issues             | State       |
| --------- | --------------------------------------------------------- | ------------------ | ----------- |
| M0        | Baseline truth reconciliation, defect inventory, ledger   | —                  | Complete    |
| M1        | Replace source-string tests; restructure the service      | —                  | Complete    |
| M2        | Reversible PostgreSQL migrations replace boot-time DDL    | #25                | Complete    |
| M3        | Crawl-target SSRF, robots.txt, and probe-surface controls | #9, #10, #30       | This change |
| M4        | Durable frontier, real cancellation, graceful shutdown    | #15, #16, #17, #21 | Planned     |
| M5        | Adaptive `browser=auto` escalation                        | #14                | Planned     |
| M6        | Tenant-isolated authenticated crawling                    | #23                | Planned     |
| M7        | Sitemap, pagination, and compliant search discovery       | #13, #22           | Planned     |
| M8        | Extraction packs and real field-level provenance          | #12, #18, #24      | Planned     |
| M9        | Delivery batching, dead-letter queue, and replay          | #19, #20           | Planned     |
| M10       | Metrics, tracing, and a generated OpenAPI contract        | #26                | Planned     |
| M11       | API rate limiting, mutation audit logs, dashboard hygiene | #11, #26, #27      | Planned     |
| M12–M15   | Reserved for cutover, canary, and production activation   | —                  | Planned     |

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
