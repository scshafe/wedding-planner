---
name: durable-storage-record-store
description: Issue #8 / ADR 0039 — all product state behind a synchronous RecordStore port (collection/partition/key JSON records) with an in-memory test adapter and a node:sqlite adapter; one transaction per request; forward-only migrations; demo seed only into an empty store
metadata:
  type: project
---

Since issue #8 (2026-10-19) every product store persists through `product/src/persistence/record_store.ts`.

**The shape.** Records are JSON addressed by `(collection, partition, key)`. A tenant-scoped store passes
`context.tenant_id` as the partition (via `TenantScopedRepository`, which still runs the brand + liveness guard,
so isolation did not move: [[multi-tenant-isolation-boundary]]); global stores use `GLOBAL_PARTITION`. The census
of collections is `persistence/collections.ts`: names are on-disk format, renaming one is a migration.

**Load-bearing invariants.**
- The port is SYNCHRONOUS on purpose (`node:sqlite` `DatabaseSync`): settle-balance and the inbound dedup rely on a
  request never yielding. Never make a transaction body async (the adapters throw if it returns a promise).
- `ProductApi.handle` wraps the route in `store.transaction()`: a throw rolls back the request's writes. A handler
  that must persist something on a failure path returns its response instead of throwing.
- Every store takes an optional trailing `store` param defaulting to `InMemoryRecordStore`. A store built in
  `compose.ts` WITHOUT the shared `store` silently stays in memory in production; the compose restart test's
  census (every `COLLECTIONS` name has rows after a recompose) is what catches it. Add every new collection to
  `COLLECTIONS` and exercise it in `product/tests/runtime/compose_persistence.test.ts`.
- Both adapters store JSON text: reads are fresh copies; `undefined`-valued keys are dropped. Tests comparing a
  re-read record with `toBe` fail by design; use `toEqual`.
- Sessions are keyed by `sha256(token)`; the raw token never reaches the file. `resolve` re-mints the Principal.
- Migrations (`sqlite_migrations.ts`) are append-only and forward-only: a newer DB is refused
  (`PERSISTENCE.SCHEMA_TOO_NEW`), so rolling back across a migration needs the pre-deploy backup. A new kind of
  record is just a new collection (no migration).

**Deploy.** `WP_DATABASE_PATH=/data/wedding-planner.sqlite` on the `./state/app:/data` bind; `state/app` is in
`stack.toml [backup] paths`; `journal_mode=DELETE` so the one file is the whole state between writes. Non-demo boot
without `WP_DATABASE_PATH` fails closed. The demo seed runs only when there is no tenant. Engines `>=22.13`.

Related: [[deployable-image-composition-root]], [[http-edge-and-intra-tenant-auth]].
