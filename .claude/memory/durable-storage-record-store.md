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
- Migrations (`sqlite_migrations.ts`) are append-only and declare `olderBuildsCanRead`. The host auto-rolls back a
  failed deploy, so an OLDER build must run on a newer DB: it opens one whose unknown migrations are all readable,
  else refuses (`PERSISTENCE.SCHEMA_TOO_NEW`). A breaking migration needs its expand step live first AND a
  `status:needs-owner` issue before merge. `open` writes `<db>.pre-vN.sqlite` before migrating an existing DB.
- New state goes into a NEW collection where it can: an older build (after a rollback) never touches it. A new
  field on an existing record is also silently DROPPED by an older build's update path, which rebuilds records field
  by field (e.g. the wedding update), not only refused by validation.
- A NEW FIELD on an existing record ships expand-then-contract (schemas are `additionalProperties:false`, so an
  older build re-validating a record with an unknown field fails): deploy the schema that accepts it first.
- The drift test migrates the FROZEN `tests/persistence/fixtures/records_vN.json` and validates every row against
  today's schemas. Never regenerate a fixture; add `records_vN.json` for a new schema version.
- Per-wedding (per-parent) stores key records with `groupedKey(wedding_id, id)` (in `idOf` AND every read/delete)
  and read one wedding with `TenantScopedRepository.listGroup(ctx, wedding_id)` (ADR 0039 addendum), never `list` +
  filter: `list` decodes the whole tenant partition, and a tenant's weddings are unbounded. SQLite serves it as a
  key range on the unique index (exact in UTF-8 byte order). Every RecordStore double in tests must forward
  `listByKeyPrefix` too. Older stores (guest_registry, escalation reply/resolution logs) still list+filter: don't
  copy them.
- `collection()` is called only in `collections.ts` (architecture test); each handle has a scope (tenant/global)
  and the census checks rows honor it. The raw store is not on `ComposedSurface`; `SqliteRecordStore` is
  edge-only (relative imports, not the barrel).
- Sessions carry `auth` (`simulated` today), `token_hash`, `expires_at` (7 days); unknown kinds are refused, lapsed
  ones deleted; `DELETE /t/:slug/sessions` revokes. Issue #10 adds a new `auth` kind and must decide what
  `simulated` sessions may still do.
- External side effects use the outbox pattern (a row in the transaction, delivered after commit); writes commit
  only when `handle` returns. The error log (#13) must write OUTSIDE the request transaction.

**Deploy.** `WP_DATABASE_PATH=/data/wedding-planner.sqlite` on the `./state/app:/data` bind; `state/app` is in
`stack.toml [backup] paths`; `journal_mode=DELETE` so the one file is the whole state between writes; `WP_REQUIRE_DATABASE`
in the stack fails the boot without a path. Non-demo boot without `WP_DATABASE_PATH` fails closed. The demo seed runs
only when there is no tenant. Engines `>=22.23.4` (raised from `>=22.13` by the 2026-10-21 security update; see [[node-pins-exact-patched]]).

Related: [[deployable-image-composition-root]], [[http-edge-and-intra-tenant-auth]].
