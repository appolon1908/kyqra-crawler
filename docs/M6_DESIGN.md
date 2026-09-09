# M6 design proposal — tenant-isolated authenticated crawling

**Status: proposed, not implemented. Awaiting the recorded human approval that #23 and
`KYQRA_MISSION.md` both require.**

This document exists so that approval is a decision about a specific design rather than a
rubber stamp on a one-line issue. Nothing in M6 is built until it is approved, and the
approval should be recorded on #23.

## Why this milestone is gated

Every other milestone in this mission is recoverable by reverting a commit. M6 is not: it
makes the crawler **hold and replay other people's credentials**. The failure that matters
is not a crawler bug, it is credential leakage — into logs, browser traces, screenshots,
callbacks, result rows, error messages, or another tenant's job. The gate is correctly
placed and this design is organised around that failure, not around the feature.

## Authorisation comes before authentication

Authenticated crawling is only legitimate where the tenant is authorised to access the
source. The design therefore makes authorisation a precondition the system enforces, not a
promise in a contract:

- A host may be crawled with credentials only when it has an approved `domains` row with
  `requires_auth = true` and a `legal_status` that permits it. `domains.approved_by` and
  `approved_at` already exist for exactly this.
- Approval of a domain is an operator action, recorded in `audit_log`, and separate from
  storing a credential for it.
- A credential for an unapproved host is refused at write time, not merely unused.

This is deliberately stricter than "the tenant gave us a password". A tenant supplying
credentials is not by itself evidence that crawling that source is authorised.

## What the schema already provides

M2 shipped the tables unused. They shape the design:

| Table         | Already has                                                                         | Gap to close in M6                                                                         |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `credentials` | `tenant_id`, `host`, `kms_key_id`, `ciphertext`, `created_by`, `rotated_at`         | no credential kind, no label, no `expires_at`, no uniqueness on `(tenant_id, host, label)` |
| `sessions`    | `tenant_id`, `host`, `encrypted_state`, `expires_at`, `last_refreshed_at`, `status` | no link to the credential that produced it, no uniqueness on `(tenant_id, host)`           |
| `audit_log`   | `tenant_id`, `principal_id`, `action`, `resource`, `before`, `after`, `ip`, `at`    | nothing structural; M6 must actually write to it                                           |

No MFA handoff table exists; M6 adds one.

## Key custody

`credentials.kms_key_id` implies envelope encryption, and that is what is proposed:

1. A per-credential data key is generated, used once to encrypt the credential with
   AES-256-GCM, and immediately discarded from memory.
2. The data key is wrapped by an external KMS key; `kms_key_id` records which one.
3. `ciphertext` stores the wrapped key, nonce, auth tag and payload together. Decryption
   requires a live KMS call, so a database dump alone is not sufficient to read a
   credential.
4. Rotation re-wraps under a new KMS key and stamps `rotated_at`, without the plaintext
   leaving the process.

**A judgement to confirm.** If no KMS is available in the target environment, the only
alternative is a file-mounted master key, as the existing secrets already use. That is
materially weaker: it collapses to "database dump plus one file". I would rather implement
the KMS path and fail closed where no KMS is configured than quietly ship the weaker one.
**This is the single most important thing to decide before implementation.**

## Tenant isolation

The invariant, stated so it can be tested:

> Every credential and session read is scoped by a `tenant_id` taken from the authenticated
> service principal, never from request input, and no code path accepts a tenant identifier
> from a caller.

This is the rule the job routes already follow — `X-Tenant-Id` must match the principal or
the request is refused. M6 extends it to credential and session storage, with the
additional constraint that a crawl worker resolves credentials from the job's owning
tenant, so a job cannot reach another tenant's session even if it names that host.

Proving it: a test with two tenants holding credentials for the _same host_, asserting that
each job uses only its own, that a direct API read of the other tenant's credential is a
404 rather than a 403, and that a crawl for tenant A never attaches tenant B's session.

## Session lifecycle

- **Acquire.** A login recipe runs in the browser worker, in an incognito context, through
  the existing pinned proxy. It produces cookies and storage state, encrypted before it
  ever leaves the worker.
- **Reuse.** Sessions are keyed by `(tenant_id, host)` and reused while `expires_at` is in
  the future and `status` is live, so a login is not repeated per page.
- **Refresh.** A session near expiry is refreshed rather than rebuilt where the site allows
  it; `last_refreshed_at` records it.
- **Revoke.** A tenant can revoke a session, and revocation is immediate — the worker
  checks status the way it already checks job cancellation.
- **Expire.** Expired session state is deleted, not merely marked, on the same bounded
  cleanup principle M4 applied to the frontier.

## MFA handoff

**The crawler never holds a second factor.** It cannot store a TOTP seed, because storing
the seed makes the second factor a first factor and defeats the control.

Proposed flow: when a login recipe meets an MFA challenge, the job moves to
`awaiting_mfa`, emits a callback naming the job and host, and waits with a short deadline.
The tenant supplies a code through a single-use, short-lived channel; the worker consumes
it in memory, completes the login, and never writes it anywhere. A code that is not
supplied before the deadline fails the job rather than retrying.

Open question for approval: whether MFA is in scope for the first cut at all. It is the
most complex part and the least reusable, and deferring it to a follow-up would let
credential storage and session reuse land sooner with a smaller blast radius. **My
recommendation is to defer MFA** and ship storage, isolation and session lifecycle first.

## Secret hygiene

Credential and session material must never reach: application logs, Crawlee logs, browser
traces or screenshots, result rows, provenance, callback payloads, job events, error
messages, or CI artifacts. Concretely:

- A redaction helper is the only path by which credential-adjacent values may be formatted,
  and logging a credential object directly is a lint error rather than a convention.
- The existing `safeLogUrl` pattern extends to stripping userinfo and query secrets.
- Browser tracing stays off for authenticated sessions unless explicitly enabled per job,
  and traces are treated as secret artifacts when it is.
- A test asserts that a completed authenticated crawl leaves no credential substring in any
  log line, event payload, or result row it produced.

## Explicitly out of scope

Naming these matters as much as the design: **credential harvesting or scraping login
forms for credentials the tenant did not supply; CAPTCHA solving or bot-detection evasion;
password reset or account recovery flows; storing TOTP seeds or any second-factor secret;
sharing a session across tenants under any circumstance; and crawling an authenticated
source whose `domains` row is not approved.** A request for any of these should be refused
rather than designed around.

## Exit criteria

1. Credentials are encrypted with a per-credential data key wrapped by a KMS key; a
   database dump alone cannot yield plaintext; the process fails closed where no KMS is
   configured.
2. A credential may only be stored for a host with an approved `domains` row permitting
   authenticated access.
3. Every credential and session read is scoped by the authenticated principal's tenant, and
   no path accepts a tenant identifier from a caller.
4. Two tenants holding credentials for the same host cannot observe or use each other's,
   proved by test, including that a cross-tenant read is a 404.
5. Sessions are reused within their lifetime, refreshed rather than rebuilt where possible,
   revocable immediately, and deleted on expiry.
6. Every credential write, read, rotation and session creation writes an `audit_log` row
   naming the principal and action, and never the secret.
7. No credential or session material appears in any log, event, trace, artifact, callback,
   provenance or result row, proved by a test that searches the output of a completed
   authenticated crawl.
8. Recorded human approval is referenced in the acceptance ledger, per the mission rules
   for M6.
9. All CI jobs pass on a fresh checkout at the proving commit, and `docs/ACCEPTANCE.md`
   links it and states what M6 does not claim.

## Decisions needed before implementation

1. **KMS or nothing?** Confirm a KMS is available, or accept a documented weaker fallback.
   I recommend failing closed without one.
2. **Is MFA in the first cut?** I recommend deferring it.
3. **Who approves a domain for authenticated crawling**, and is that the same reviewer who
   approves this milestone?
4. **What proves a tenant is authorised** for a login-walled source — is an approved
   `domains` row sufficient, or is an attestation required alongside it?
