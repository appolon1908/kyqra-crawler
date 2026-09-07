# Atomic staging deployment

The backend is published only on `127.0.0.1:3100`. Nginx terminates mTLS on
`10.40.0.4:18444` for `kyqra.internal.codestra.agency` and proxies to that
loopback backend. UFW permits only `10.40.0.1` on VLAN interface
`enp5s0.4001` to TCP/18444.

The public virtual host exposes only the Basic-authenticated UI and safe GET
health endpoints. Every job, result, cancellation, retry, statistics and
callback path is denied at the public edge and remains available only behind
the private mTLS listener and application bearer authentication.

The privileged installer verifies the release manifest, fixed paths, commit,
image digest, certificates, configuration and backups, then changes Compose,
Nginx and UFW as one transaction. Any failed verification invokes rollback.
The Kyqra API and worker containers are quiesced for the storage cutover; other
provider containers are not changed.
The exact image is loaded from the signed, checksummed release bundle, so the
Provider requires no registry credential and performs no floating-tag pull.

The Compose transaction includes a one-shot `migrate` service. It waits for
PostgreSQL, acquires the `node-pg-migrate` advisory lock, applies the checked-in
SQL migrations, and must exit successfully before the API can start. API and
worker startup contain no DDL. Before deployment, the installer records the
exact running application-service set, stops every API and worker writer, and
backs up both PostgreSQL and the persisted Redis volume while writers remain
stopped.

The fixed-path privileged installer enforces that migration dependency in the
rendered Compose model, stops the fixed Kyqra application service set, and runs
the pinned image's one-shot migrator before recreating the API and every worker.
Automatic rollback keeps those containers stopped, restores the checksummed
pre-install PostgreSQL dump and Redis volume, and only then recreates the exact
prior API/worker set with the prior immutable image, so a cutover cannot mix
code, schema, and queue state from different points in time.
