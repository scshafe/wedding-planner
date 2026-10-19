# ADR 0039 — Durable storage: a RecordStore port over SQLite

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #8 (M1 "Real foundations" in `ROADMAP.md`)
- **Scope:** every piece of product state survives a restart or a deploy. A persistence port that all the
  in-memory stores move behind, a durable SQLite adapter with versioned migrations, the stack bind and backup,
  and the demo seed running only into an empty store.
- **Builds on** the tenant-isolation boundary ([[multi-tenant-isolation-boundary]], ADR 0012) and the
  composition root ([[deployable-image-composition-root]], ADR 0016).

## Context

Every store was an in-memory `Map`: tenants and the slug index, the `TenantScopedRepository` partitions under
weddings, guests, escalations, resolutions, replies and inbound receipts, the billing ledger, the messaging meter
and the session store. Each deploy reset production to the demo seed, so nobody could use the product for real.

Constraints: the request pipeline is synchronous and some invariants depend on that (settle-balance reads the
balance then pays it in one critical section; the inbound dedup checks then records). Tenant isolation is
enforced in `TenantScopedRepository` from a minted `TenantContext` and must not move or weaken. The container
runs `read_only` as uid 1000 and may only write under the stack's `./state` bind. The image has no compiler
toolchain.

## Decision

### One generic port: `RecordStore`

`product/src/persistence/record_store.ts` defines a small synchronous port. Every record is JSON addressed by
`(collection, partition, key)`, with `get`, `list` (first-insertion order, which is the `Map` semantics the
stores already had), `put` (replacing keeps the position), `delete`, `isEmpty(collection)` and
`transaction(fn)`. Collections are typed handles (`collection<T>(name)`), and `collections.ts` is the census
of all of them. Their names are part of the on-disk format.

The stores keep their public APIs. Each takes an optional trailing `store` parameter that defaults to a fresh
`InMemoryRecordStore`, so the ~200 test construction sites are unchanged and the in-memory adapter remains
the test adapter. `composeProductSurface` builds every store over ONE injected store. If the composition
root missed a store, that store would quietly stay in memory, so the compose restart test exists to catch it:
it writes through every store, recomposes over the same file and checks that every collection in the census
has rows in the database.

A generic key-value port, rather than a table per aggregate, because:
- The stores already are key-value maps partitioned by tenant. Moving them is mechanical and keeps every
  invariant where it was.
- A new kind of record (users, invites, outbox messages, feedback in the next M1 issues) is a new collection
  name and needs no migration.
- Queries stay in the domain code, as they were (e.g. `getByEscalationId` scans the partition), and the
  scale is small: studios with 5–40 weddings a year. A collection that ever needs an index can get a dedicated
  table through a migration without changing its store's API.

### Isolation is unchanged and sits above the port

`TenantScopedRepository` still runs `assertMintedContext` and the liveness check on every operation. It passes
`context.tenant_id` as the store partition. The port has no cross-partition read, so a store only ever sees
the partition this layer selected. Platform-global collections (tenants, the slug index, sessions) use
`GLOBAL_PARTITION`. The tenant isolation keystone and the HTTP keystone now run against both adapters, with
all stores sharing one store as compose wires them.

### SQLite through `node:sqlite`

The durable adapter (`sqlite_record_store.ts`) uses Node's built-in `node:sqlite` `DatabaseSync`:
- **No native dependency.** `better-sqlite3` would need prebuilt binaries or a toolchain in the image build.
- **Synchronous API,** so the port stays synchronous and no handler has to become async.
- **Cost:** `node:sqlite` is marked experimental. Node 22 prints one `ExperimentalWarning` at startup, and it
  needs Node ≥ 22.13, the version that dropped the flag. `engines` is now `>=22.13`, which matches the
  `node:22-slim` image and CI on Node 22. The adapter uses only the long-stable core of the API (`prepare`,
  `get`/`all`/`run`, `exec`), and the shared contract suite would catch drift.

One table, `records(seq INTEGER PRIMARY KEY, collection, partition, key, body, UNIQUE(collection, partition,
key)) STRICT`:
- `seq` is the rowid alias. It orders `list` by first insertion, and an upsert keeps it.
- Reads decode a fresh copy every time. There is no cache, so a rolled-back transaction leaves nothing stale
  in memory. The in-memory adapter also stores JSON text, so the fast tests see the same copy and
  JSON-only semantics.

### One transaction per request

`ProductApi.handle` runs the whole route inside `store.transaction()`:
- A request that throws part-way leaves none of its writes behind, and a request's writes become durable
  together. For example, provisioning writes the tenant, the slug index and a billing event.
- A nested `transaction` is a savepoint in both adapters.
- A handler that must persist something on a failure path has to return its response, not throw. Today none
  does.
- Side effects outside the store, such as a real provider send (an M5 crossing), are not covered by the
  rollback. That adapter will have to order its send after the writes, or make it idempotent.

### Versioned, forward-only migrations at boot

`sqlite_migrations.ts` is an append-only list, applied in one transaction at open and recorded in
`schema_migrations(version, name, applied_at)`, with the time from the injected clock. Opening is fail-closed:
- a database with more migrations than the build knows → `PERSISTENCE.SCHEMA_TOO_NEW`;
- a history that diverges from the list → `PERSISTENCE.MIGRATION_MISMATCH`;
- an unopenable file → `PERSISTENCE.OPEN_FAILED`.

In each case the entrypoint refuses to boot and the deploy rolls back. Rolling the code back past a migration
therefore needs the pre-deploy backup. Version 1 only creates `records`.

### Configuration and the demo seed

`WP_DATABASE_PATH` selects the SQLite store. When it is unset, the store is in memory, which is allowed only
in demo mode. A non-demo boot without it fails closed, the same policy as the credential tokens. The boot log
names the storage, or warns that the in-memory store resets on restart.

The demo seed runs only when the store has no tenant, inside one transaction. A restart over existing data
seeds nothing, and the log notes that the seed was skipped.

### Sessions are stored by hash

The session store keys records by `sha256(token)`. The raw bearer token never reaches the database file or
its backups; a test reads the file to check. `resolve` re-mints the `Principal` from the stored record on each
call, so the store remains the sole mint. Session expiry and server-side sign-out come with real accounts
(issue #10).

### The stack and the backup

- `deploy/stack/compose.yaml` binds `./state/app:/data` (read-write, the app's only writable path) and sets
  `WP_DATABASE_PATH=/data/wedding-planner.sqlite`.
- `stack.toml` `[backup] paths` adds `state/app`.
- The database runs with `journal_mode=DELETE` and `synchronous=FULL`, so between transactions the single
  file is the whole state. There is no `-wal` file holding committed data that a file-level copy could miss.
  A copy taken while a write is in flight can still be torn. The deployment is tailnet-only with low traffic,
  and the retention keeps older copies, so this ADR accepts that.
- `busy_timeout=5000` lets an overlapping container wait for the lock instead of failing.

## Consequences

- A deploy no longer wipes data. Production is still in demo mode: the demo tenant is seeded once, into the
  empty database on the first deploy, and then persists.
- The first deploy needs `state/app` to exist and be writable by uid 1000. The host's stack tool creates
  read-write bind paths. If ownership were wrong, the app would refuse to boot and the deploy would roll back
  to the previous image.
- Restore: stop the app and put `wedding-planner.sqlite` back into `state/app/`.
- Later M1 issues add collections (users, invitations, the email outbox, feedback, errors) without
  migrations.
- Not done: online backup through the SQLite backup API, dedicated tables or indexes, and multi-process
  writers. Each is a later step if scale or the owner's backup tooling calls for it.

## Alternatives considered

- **A JSON snapshot file rewritten on every mutation:** simple and always backup-consistent (atomic rename),
  but O(state) per write. It also has no transactions across stores.
- **`better-sqlite3`:** mature and synchronous, but it is a native module, so the slim image would need
  prebuilt binaries downloaded at build time or a toolchain.
- **An async port with Postgres:** a second service in the stack, and an async rewrite of every handler that
  would break the synchronous critical sections the billing and dedup invariants rely on. Not justified at
  this scale.
