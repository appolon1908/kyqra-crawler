# Kyqra Crawler — Codestra Integration Fabric v2

## Canonical authority

`appolon1908-hue/kyqra-crawler` is the canonical future repository for Kyqra crawler runtime and integration work. The older `scrapper` repository remains historical/current-lineage evidence until an explicit migration and archive decision is reviewed.

Kyqra owns crawl jobs, target policy, queue state, worker execution, raw results, normalized results, review state, delivery state, retention and crawler-specific privacy actions. Crawlee, Playwright, BullMQ/Redis and the results database remain internal.

Middleware is the only cross-system write boundary. n8n coordinates job timing, human review and approved writeback through Middleware; it does not crawl, call search providers, read Kyqra Redis/PostgreSQL, or write Odoo directly.

## Communication path

```text
Odoo/product discovery request -> Middleware target policy -> Kyqra API
Kyqra result/event -> durable outbox -> Middleware
n8n -> Middleware only -> Kyqra adapter
approved result -> Middleware -> Odoo/product adapter
```

## Correctness

- target allowlist and privacy policy are evaluated before job creation;
- tenant and per-company isolation are preserved inside batch jobs;
- job submission is idempotent;
- duplicate callbacks produce one logical effect;
- unknown job outcomes are reconciled before retry;
- no result reaches Odoo without policy and review approval;
- privacy deletion and retention are protected, auditable operations;
- dead-letter replay is never automatic.

## API surface

- job create/read/pause/resume/cancel;
- result and delivery state;
- human review approve/reject/merge/split;
- suppression and privacy deletion;
- retention operations;
- usage and worker-capacity projection;
- signed Middleware callback delivery.

## Capabilities

```text
CRAWLER_EXECUTION=false
CRAWLER_WRITEBACK=false
PRIVACY_WRITE=false
ODOO_WRITE=false
DEAD_LETTER_REPLAY=false
```

## Branch program

```text
main
  -> integration/codestra-crawler-fabric-v2
       -> integration/middleware-crawler-api-v1
       -> automation/result-event-outbox-v1
       -> feature/crawler-review-workflow-v1
       -> feature/crawler-privacy-retention-v1
       -> feature/crawler-capacity-observability-v1
       -> test/crawler-fabric-contracts-v1
```

No branch starts crawlers, changes target policy, writes Odoo, activates n8n, or changes production.
