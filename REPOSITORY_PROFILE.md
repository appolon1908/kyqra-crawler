# Repository Profile — `kyqra-crawler`

## Identity

- **Repository:** `appolon1908-hue/kyqra-crawler`
- **Category:** Runtime service — canonical crawler
- **Visibility:** `public`
- **Default branch:** `main`
- **Authority:** Canonical Kyqra crawler API, queue, workers, persistence, and callback authority
- **Status:** Production-oriented Fastify/Crawlee/Playwright service with documented capability gaps and hardening work.

## Purpose

Executes tenant-scoped crawl jobs through bounded HTTP and browser workers, persists status/results, supports retries/cancellation, and returns signed results to approved Middleware callbacks.

## Owns

- Crawl job API and authoritative job ledger
- BullMQ/Redis scheduling, workers, PostgreSQL persistence, and result storage
- URL policy, callback allowlists, signed delivery, backup, and restore

## Does not own

- Direct Odoo or product-database writes
- Cross-system business authorization
- Capabilities documented as not implemented, including full extraction/discovery/auto-browser behavior

## Key integrations

- Kong and Middleware
- n8n/Odoo through governed result events
- Redis, PostgreSQL, Crawlee, Playwright, and approved target/callback allowlists

## Current priorities

1. Close documented API/capability gaps honestly
2. Add OpenAPI, metrics, stronger authentication, and protected dependency health
3. Prove callback idempotency, reconciliation, retention, and queue recovery
4. Complete immutable staging, canary, rollback, and production evidence

## Governance and safety

- Target promotion model: `feature/docs/fix/security/upgrade -> development -> test -> staging -> production -> main`.
- Use pull requests and exact-head/merge-result validation; merging source never authorizes deployment.
- Never commit API keys, callback secrets, browser credentials, customer data, database dumps, or secret-bearing evidence.
- Production images and releases must be immutable; mutable `latest` tags are not release authority.
- Crawls and callbacks must remain policy-bounded; the crawler may never become a direct cross-system writer.
- This document does not activate crawling or production traffic.

## Account-wide catalog

See `appolon1908-hue/documentaions/REPOSITORY_CATALOG.md`.
