/**
 * @canonical record_store -- the persistence port every product store sits behind (issue #8, ADR 0039).
 *
 * The product's state is a set of small JSON records, each addressed by `(collection, partition, key)`:
 *
 *   - `collection` names the kind of record (one per store; the census is `collections.ts`). It is part of the
 *     persisted format: renaming one needs a migration.
 *   - `partition` is the isolation unit. A tenant-scoped store passes `context.tenant_id` (taken from a minted
 *     TenantContext by `TenantScopedRepository`, never from a payload); a platform-global store (tenants,
 *     sessions) passes {@link GLOBAL_PARTITION}. There is no cross-partition read: `get`/`list`/`delete` all take
 *     the partition, so a store can only ever see the partition its caller selected.
 *   - `key` is the record's id within the partition.
 *
 * Semantics both adapters guarantee (pinned by the shared contract suite, run against each):
 *   - `list` returns a partition's records in FIRST-INSERTION order; replacing a record keeps its position, and a
 *     deleted-then-reinserted key moves to the end (exactly `Map` semantics, which the in-memory stores had).
 *   - Every read returns a FRESH copy decoded from the stored JSON: mutating a returned record never changes the
 *     store, and a record holds only JSON values (no `undefined` keys, no Dates, no functions).
 *   - `transaction(fn)` is atomic: either every write `fn` made lands, or (when `fn` throws) none does and the
 *     error propagates. A nested call is a savepoint: if it throws, only its own writes are undone (even when
 *     the outer call catches the error), and its writes become durable only when the outermost call commits.
 *     Everything is synchronous — the request pipeline is synchronous, so a whole request is one critical
 *     section and one transaction.
 *
 * The port is synchronous on purpose: the product's invariants (settle-balance's read-then-pay, the inbound
 * dedup's check-then-record) rely on a request never yielding mid-way, and `node:sqlite` offers a synchronous
 * API, so persistence does not force an async rewrite of every handler.
 *
 * related: in_memory_record_store.ts (the test/demo adapter), sqlite_record_store.ts (the durable adapter),
 * collections.ts (the census), tenant_scoped_repository.ts (the tenant-isolation layer above this port).
 */

/** The partition a platform-global (not tenant-owned) collection uses. Tenant ids are `tenant_…`, never this. */
export const GLOBAL_PARTITION = '_global'

/**
 * A typed collection handle. The record type is a phantom (compile-time only): it ties every read and write of
 * a collection to one shape, so two call sites cannot disagree about what a collection holds.
 */
export interface Collection<T> {
  readonly name: string
  /** Phantom marker for the record type — never set at runtime. */
  readonly __record?: T
}

/** Define a collection handle. Names are lowercase snake_case (they are persisted). */
export function collection<T>(name: string): Collection<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid collection name '${name}'.`)
  return Object.freeze({ name })
}

/** The persistence port. See the module docstring for the guarantees every adapter keeps. */
export interface RecordStore {
  /** The record under `(collection, partition, key)`, or `undefined`. */
  get<T>(collection: Collection<T>, partition: string, key: string): T | undefined
  /** Every record in `(collection, partition)`, in first-insertion order. */
  list<T>(collection: Collection<T>, partition: string): T[]
  /** Insert or replace a record. A replaced record keeps its position in `list`. */
  put<T>(collection: Collection<T>, partition: string, key: string, record: T): void
  /** Remove a record. Returns whether one existed. */
  delete<T>(collection: Collection<T>, partition: string, key: string): boolean
  /** Whether the collection holds no record in ANY partition (the demo seed's "is the store empty" check). */
  isEmpty<T>(collection: Collection<T>): boolean
  /** Run `fn` atomically (all of its writes or none). A nested call is a savepoint inside the outer one. */
  transaction<R>(fn: () => R): R
}

/** The narrow capability a request pipeline needs: run one request as one transaction. */
export type TransactionRunner = Pick<RecordStore, 'transaction'>

/**
 * Adapters call this on a transaction body's result: a body must not return a promise, because the writes it
 * awaits would land after the transaction committed.
 */
export function assertSynchronousResult(result: unknown): void {
  if (typeof (result as { then?: unknown } | null)?.then === 'function') {
    throw new Error('RecordStore.transaction takes a synchronous function; it returned a promise.')
  }
}
