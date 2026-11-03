# Codestra Middleware Integration Contract

This repository remains independently buildable, testable, deployable, observable, and rollback-capable. Cross-system integration follows the Codestra canonical control plane instead of duplicating business/provider authority.

## Canonical integration path

Public client -> Caddy -> Kong -> Middleware integration API :8095 -> /platform/v1 command kernel -> durable idempotency + command ledger -> outbox/worker -> owned adapter -> downstream domain/provider -> readback/reconciliation -> audit/metrics/traces

## Repository requirements

1. Standalone ownership: this repository owns its domain logic/data or declared infrastructure function and must build/test/deploy/rollback independently.
2. Cross-system effects: new cross-repo/provider-changing effects use Middleware /platform/v1 commands. No new parallel command authority or direct provider-effect bypass.
3. Durability: effectful work requires idempotency, operation identity, durable persistence/ledger/outbox, replay-safe failure semantics, readback and reconciliation.
4. Ownership: every service/adapter/connector has one declared owner. Runtime metadata must be representable in Middleware /platform/v1/services: service_id, owner, repository, environment, health, metrics, OpenAPI when applicable, dependencies, SLO, deployment SHA, status.
5. Identity: Keycloak is central IdP. JWT signature, issuer, audience, azp/client, scopes/roles and tenant binding fail closed.
6. Edge: Caddy owns public TLS; Kong owns gateway policy; Middleware integration traffic targets :8095. /internal/* and /metrics are never public.
7. Secrets: OpenBao/governed secret references are authoritative. Secrets are not committed, embedded in images or copied into evidence.
8. Automation: n8n owns bounded workflow automation, not a parallel command ledger.
9. Observability: monitoring components consume telemetry; they do not perform business/provider effects.
10. Contracts: API repos maintain generated/drift-checked OpenAPI, Postman and route-authority artifacts where applicable.
11. Production safety: calling, SMS/email writes, billing/money movement, social/provider writes and other production effects are default-deny until explicit certification passes.
12. Promotion: Development -> Testing -> Staging -> Production requires immutable SHA/image identity, readback, observability and rollback proof.

## Repository role classification

Each repo must be classified as one of: Product/domain service; Provider adapter/connector; Edge; Identity/security; Automation; Observability; Data/platform; Client/UI/workstation/device.

## Design review checklist

- [ ] role and owner explicit
- [ ] standalone build/test/deploy/rollback
- [ ] health/readiness defined
- [ ] metrics/telemetry boundary defined
- [ ] API/OpenAPI/Postman governed where applicable
- [ ] Middleware command/adapter relationship explicit
- [ ] no duplicate direct provider-effect authority
- [ ] Keycloak/tenant boundary fail-closed
- [ ] secrets use governed references
- [ ] idempotency/readback/reconciliation for effects
- [ ] CI/rulesets/required checks
- [ ] staging/readback/rollback evidence
- [ ] production effects default-deny

## Source of truth

GitHub = code/PR/CI truth. Linear = execution truth. Notion = durable architecture/context. Runtime observability = deployed truth.

Documentation alone does not certify compliance; implementation and staging evidence must pass the checklist.