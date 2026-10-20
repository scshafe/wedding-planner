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
`transaction(fn)`.

Collections are typed handles, `collection<T>(name, scope, schema?)`:
- `collections.ts` is the census of all of them, and an architecture test makes it the only place
  `collection()` is called.
- The scope is `tenant` (partitioned by tenant id) or `global`, and `TenantScopedRepository` refuses a global
  collection.
- `schema` names the JSON Schema contract the collection's records satisfy, when there is one.
- Names are part of the on-disk format. The messaging binding is `guest_binding`, which leaves `guest` free for
  the M2 guest list.

The stores keep their public APIs. Each takes an optional trailing `store` parameter that defaults to a fresh
`InMemoryRecordStore`, so the ~200 test construction sites are unchanged and the in-memory adapter remains
the test adapter. `composeProductSurface` builds every store over ONE injected store. If the composition
root missed a store, that store would quietly stay in memory, so the compose restart test exists to catch it:
it writes through every store, recomposes over the same file and checks that every collection in the census
has rows in the database, and that every row honors its collection's scope.

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

The raw store never leaves the composition root:
- `ComposedSurface` does not expose it, and the product barrel exports neither the census nor `GLOBAL_PARTITION`.
- Code that held the store could read any partition or plant a session row. Only the stores themselves, and
  the tests of the port, address raw records.
- The SQLite adapter is an edge primitive like the wall clock. It is exported from no barrel and imported by
  relative path in `app/server.ts` and its tests, so loading the product never loads `node:sqlite`.

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
  JSON-only semantics. Its transactions snapshot lazily, at the first write, so a read-only request copies
  nothing.

Hardening at open:
- `busy_timeout` is set first, so the PRAGMAs that take locks wait for an overlapping process instead of
  failing the boot.
- `secure_delete=ON`, so a removed guest does not linger in the file or its backups.
- `max_page_count` caps the file at 1 GiB. A runaway writer then fails its own requests with
  `PERSISTENCE.STORAGE_FAILED` instead of filling the laptop's disk.
- The file and its snapshots are mode 0600.

Runtime SQLite failures (disk full, I/O, a lock timeout) surface as `PERSISTENCE.STORAGE_FAILED`, with the SQLite
error as the `cause`. A failing `ROLLBACK` never replaces the error that caused it.

### One transaction per request

`ProductApi.handle` runs the whole route inside `store.transaction()`:
- A request that throws part-way leaves none of its writes behind, and a request's writes become durable
  together. For example, provisioning writes the tenant, the slug index and a billing event.
- A nested `transaction` is a savepoint in both adapters.
- A handler that must persist something on a failure path has to return its response, not throw. Today none
  does. In particular, the operability error log (#13) writes in `handle`'s catch, outside the transaction.
- `GET /healthz` answers outside any transaction, so liveness never waits on the store's lock.
- **Side effects outside the store use the outbox pattern.** Nothing inside a route runs "after the writes",
  because the writes commit only when `handle` returns. A real external effect, such as a provider send (an M5
  crossing), is therefore recorded as an outbox row inside the transaction and delivered by a dispatcher after
  commit, through an `onCommit` hook on the runner or a separate loop. The simulated email adapter (#9) is
  exactly that row; today's simulated messaging send is harmless to repeat.

### Versioned migrations at boot, and rollback

`sqlite_migrations.ts` is an append-only list, applied in one transaction at open and recorded in
`schema_migrations(version, name, applied_at, older_builds_can_read)`, with the time from the injected clock.
Opening is fail-closed:
- a history that diverges from the list → `PERSISTENCE.MIGRATION_MISMATCH`;
- an unopenable file → `PERSISTENCE.OPEN_FAILED`;
- a database migrated by a newer build with a migration older builds cannot read → `PERSISTENCE.SCHEMA_TOO_NEW`.

The host rolls a failed deploy back automatically, and the loop's revert policy merges a revert, so an older
build must be able to run on a database a newer build touched. The reader of a newer database is always the
older build, so the rules for that are fixed in this first build:

- **Migrations are rollback-safe by default.** Each migration declares `olderBuildsCanRead`. An older build opens
  a newer database when every migration it does not know is flagged readable (an added table or index, an added
  optional field), and refuses it otherwise.
- **A breaking migration (`olderBuildsCanRead: false`) needs an owner sign-off.** It breaks the automatic
  rollback, so it ships only after its expand step has been live, and with a `status:needs-owner` issue opened
  before the merge.
- **There is always a restore point.** Before migrating an existing database, `open` writes a consistent
  `VACUUM INTO` snapshot beside it, `wedding-planner.sqlite.pre-vN.sqlite`, inside the backed-up `state/app`.
- **A new field ships expand-then-contract.** Every product schema is `additionalProperties: false`, so an older
  build re-validating a record that carries a field it does not know fails, even though no migration ran. A new
  field therefore ships in two deploys: first the schema and code that accept it, then the code that writes it.
- **Drift is tested.** `tests/persistence/fixtures/records_vN.json` freezes the records each schema version wrote.
  The drift test loads them at that version, migrates them with today's build and validates every row against
  today's collection census and schemas. A required field, or a renamed collection, without its data migration
  fails CI. Fixtures are never regenerated.

Version 1 only creates `records`.

### Configuration and the demo seed

`WP_DATABASE_PATH` selects the SQLite store. When it is unset, the store is in memory, which is allowed only
in demo mode. A non-demo boot without it fails closed, the same policy as the credential tokens. The deployed
stack also sets `WP_REQUIRE_DATABASE=true`, so a compose file that lost `WP_DATABASE_PATH` cannot silently put
demo-mode production back in memory. The boot log names the storage, or warns that the in-memory store resets
on restart. `.gitignore` and `.dockerignore` exclude `*.sqlite*`, `wp-data/` and `deploy/stack/state/`.

The demo seed runs only when the store has no tenant, inside one transaction. A restart over existing data
seeds nothing, and the log notes that the seed was skipped.

### Sessions are stored by hash, expire, and can be revoked

Before this change every deploy expired every session as a side effect. Now sessions persist, so they need
their own lifecycle:
- The session store keys records by `sha256(token)`. The raw bearer token never reaches the database file or its
  backups; a test reads the file to check.
- `resolve` re-mints the `Principal` from the stored record on each call, so the store remains the sole mint.
- Each record carries its `auth` kind (`simulated` today, the role picker), its `token_hash`, and
  `issued_at`/`expires_at` (7 days).
- A lookup refuses an unknown kind and an expired session, deleting the expired one.
- `DELETE /t/:slug/sessions`, which the browser Sign out form calls, revokes a session on the server.
- Lapsed sessions are swept at boot.
- The unauthenticated login persists only a bounded, id-shaped `wedding_id`, and the guest refs gained
  `maxLength`, so no anonymous request can store an unbounded value.
- Real accounts (#10) add a new `auth` kind. That issue must decide what the existing `simulated` sessions may
  still do.

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
- Restore: stop the app and put `wedding-planner.sqlite` back into `state/app/` (or a `.pre-vN.sqlite`
  snapshot, renamed).
- Later M1 issues add collections (users, invitations, the email outbox, feedback, errors) without
  migrations.
- Not done:
  - online backup through the SQLite backup API;
  - dedicated tables or indexes (a key-prefix range `list` landed later: see the addendum);
  - multi-process writers;
  - pinning `@types/node` to Node 22, which CI's Node 22 run partly covers.

  Each is a later step if scale or the owner's backup tooling calls for it.

## Alternatives considered

- **A JSON snapshot file rewritten on every mutation:** simple and always backup-consistent (atomic rename),
  but O(state) per write. It also has no transactions across stores.
- **`better-sqlite3`:** mature and synchronous, but it is a native module, so the slim image would need
  prebuilt binaries downloaded at build time or a toolchain.
- **An async port with Postgres:** a second service in the stack, and an async rewrite of every handler that
  would break the synchronous critical sections the billing and dedup invariants rely on. Not justified at
  this scale.

## Addendum (2026-10-19): `listByKeyPrefix`

The guest list (issue #27) is the first store whose records belong to a parent inside the tenant (a wedding) and
can be numerous: up to 2000 guests per wedding, with no bound on a tenant's weddings. Reading a wedding's guests
with `list` decodes the whole tenant partition and filters it, so every guest-list request would cost
O(every guest the tenant ever had), and so would every other per-wedding store M2 adds (events, RSVPs, checklist,
vendors, budget).

- **Decision:** the port gains `listByKeyPrefix(collection, partition, prefix)`, the records whose key starts with
  `prefix`, in the same first-insertion order as `list`. A per-wedding store keys its records with
  `groupedKey(wedding_id, id)` (`<wedding_id>/<id>`) in its `idOf` and every `read`/`delete`, and reads one wedding
  with `TenantScopedRepository.listGroup(context, wedding_id)`, which keeps the partition, brand and liveness guards
  of `list`. The helpers are the one place the format lives; a group id is non-empty and holds no `/`.
- **The prefix must end with `/`** (PERSISTENCE.INVALID_KEY_PREFIX otherwise). That makes a prefix name exactly one
  group (`w1/` never matches `w10/…`), and it gives SQLite an exact key range, `key >= 'p/' AND key < 'p0'` ('0' is
  the byte after '/') in UTF-8 byte order. The existing `UNIQUE (collection, partition, key)` index answers that
  range, so there is no migration and no new index; a test pins the database encoding (UTF-8) and the adapter's own
  query plan (`LIST_BY_KEY_RANGE_SQL`).
- **Existing stores are unchanged:** their keys and data stay as they are, including the ones that still list a
  whole partition and filter by wedding (`guest_registry.ts`, `escalation_reply_log.ts`, the escalation resolution
  log's `listForWedding`; the reply log's `:` composite key). Do not copy them. Re-keying one is a data migration,
  done when its size calls for it.
- **Not done:** `deleteByKeyPrefix` (deleting a wedding lists then deletes, per collection); a cross-wedding view
  (the checklist's "overdue across weddings") reads the active weddings and then each group, never `list`.

