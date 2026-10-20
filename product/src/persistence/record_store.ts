import type { ContractKey } from '@wedding-planner/shared'

import { ProductError } from '../product_error'

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
 *   - `listByKeyPrefix` returns, in the same order, only the records whose key starts with a prefix ending in `/`.
 *     A store that groups records under a parent keys them `<parent_id>/<id>` (a wedding's guests:
 *     `<wedding_id>/<guest_id>`) and reads one group without decoding the whole partition — the SQLite adapter
 *     answers it from the `(collection, partition, key)` unique index as a key range.
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
 * Which partitions a collection uses: `tenant` collections are partitioned by tenant_id (and, when they hold
 * tenant-owned records, are only reached through `TenantScopedRepository`); `global` collections use only
 * {@link GLOBAL_PARTITION}. The compose census asserts every stored row honors its collection's scope.
 */
export type CollectionScope = 'tenant' | 'global'

/**
 * A typed collection handle. The record type is a phantom (compile-time only): it ties every read and write of
 * a collection to one shape, so two call sites cannot disagree about what a collection holds. `schema` names the
 * JSON Schema contract every record must satisfy, when the collection has one (the drift test validates stored
 * records against it).
 */
export interface Collection<T> {
  readonly name: string
  readonly scope: CollectionScope
  readonly schema?: ContractKey
  /** Phantom marker for the record type — never set at runtime. */
  readonly __record?: T
}

/**
 * Define a collection handle. Names are lowercase snake_case (they are persisted). Call this ONLY in
 * `collections.ts` (an architecture test enforces it), so the census stays the complete list.
 */
export function collection<T>(name: string, scope: CollectionScope, schema?: ContractKey): Collection<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new ProductError('PERSISTENCE.INVALID_COLLECTION', `Invalid collection name '${name}'.`, { context: { name } })
  }
  return Object.freeze({ name, scope, ...(schema === undefined ? {} : { schema }) })
}

/** The persistence port. See the module docstring for the guarantees every adapter keeps. */
export interface RecordStore {
  /** The record under `(collection, partition, key)`, or `undefined`. */
  get<T>(collection: Collection<T>, partition: string, key: string): T | undefined
  /** Every record in `(collection, partition)`, in first-insertion order. */
  list<T>(collection: Collection<T>, partition: string): T[]
  /**
   * The records in `(collection, partition)` whose key starts with `prefix`, in first-insertion order. `prefix` is
   * non-empty and ends with `/` ({@link assertKeyPrefix}), so `w1/` never matches `w10/…`; a store builds it with
   * {@link keyPrefixOf}.
   */
  listByKeyPrefix<T>(collection: Collection<T>, partition: string, prefix: string): T[]
  /** Insert or replace a record. A replaced record keeps its position in `list`. */
  put<T>(collection: Collection<T>, partition: string, key: string, record: T): void
  /** Remove a record. Returns whether one existed. */
  delete<T>(collection: Collection<T>, partition: string, key: string): boolean
  /** Whether the collection holds no record in ANY partition (the demo seed's "is the store empty" check). */
  isEmpty<T>(collection: Collection<T>): boolean
  /** Run `fn` atomically (all of its writes or none). A nested call is a savepoint inside the outer one. */
  transaction<R>(fn: () => R): R
}

/**
 * Refuse a key prefix that is empty or does not end with `/` (PERSISTENCE.INVALID_KEY_PREFIX). The trailing `/` makes
 * a prefix name exactly one group, and gives the SQLite adapter an exact key range: [`p/`, `p0`).
 */
export function assertKeyPrefix(prefix: string): void {
  if (prefix.length < 2 || !prefix.endsWith('/')) {
    throw new ProductError('PERSISTENCE.INVALID_KEY_PREFIX', 'A key prefix is a non-empty group id followed by "/".', {})
  }
}

/**
 * @canonical grouped_key -- the key of a record grouped under a parent: `<group_id>/<id>`. A store that groups its
 * records builds every key with this (its `idOf`, and each `read`/`delete`) and reads a group with
 * {@link keyPrefixOf}, so the two cannot disagree. A group id is non-empty and holds no `/`
 * (PERSISTENCE.INVALID_KEY_PREFIX), so one group's prefix never reaches into another.
 */
export function groupedKey(group_id: string, id: string): string {
  return `${keyPrefixOf(group_id)}${id}`
}

/** The prefix that reads one group with `listByKeyPrefix`: `<group_id>/`. */
export function keyPrefixOf(group_id: string): string {
  if (group_id.length === 0 || group_id.includes('/')) {
    throw new ProductError('PERSISTENCE.INVALID_KEY_PREFIX', 'A group id is non-empty and holds no "/".', {})
  }
  return `${group_id}/`
}

/** The narrow capability a request pipeline needs: run one request as one transaction. */
export type TransactionRunner = Pick<RecordStore, 'transaction'>

/**
 * Adapters call this on a transaction body's result: a body must not return a promise, because the writes it
 * awaits would land after the transaction committed.
 */
export function assertSynchronousResult(result: unknown): void {
  if (typeof (result as { then?: unknown } | null)?.then === 'function') {
    throw new ProductError(
      'PERSISTENCE.ASYNC_TRANSACTION',
      'RecordStore.transaction takes a synchronous function; it returned a promise.',
      {},
    )
  }
}
