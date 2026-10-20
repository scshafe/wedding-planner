import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { type Collection, keyPrefixOf, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import { assertMintedContext, type TenantContext } from './tenant_context'
import type { TenantLivenessCheck } from './tenant_store'

/**
 * @canonical tenant_scoped_repository -- the physical tenant-isolation boundary.
 *
 * A generic store partitioned by tenant. EVERY read/list/write takes a {@link TenantContext}
 * and the partition is selected by `context.tenant_id` ALONE — never by a tenant_id read from a
 * payload or passed as a separate argument (inv. 4). The isolation guarantees, by construction:
 *
 *   - Each op first runs `assertMintedContext` (rejects a forged/cast context, PRODUCT.FORGED_CONTEXT)
 *     then re-asserts the tenant is still usable (liveness at use, fail closed — a context held past a
 *     suspension stops working: PRODUCT.TENANT_NOT_USABLE). The context carries no cached authority.
 *   - `read` returns `T | undefined`: a foreign-tenant id and a never-existed id return the
 *     byte-identical `undefined` via the SAME code path, with no side effect — no existence oracle.
 *   - `list` returns only the context partition's records, ever; `listGroup` only one group of them.
 *   - `delete` removes by id WITHIN the context partition only; a foreign/missing id is a byte-identical
 *     no-op returning `false` via the same path (no cross-tenant reach, no existence oracle).
 *   - `put` stamps nothing; it COMPARES `record.tenant_id` to the context and vetoes a mismatch
 *     (PRODUCT.CROSS_TENANT_WRITE) on create and update alike. The payload field is compare-only.
 *   - There is NO unscoped / all-tenants accessor (inv. 9), and the backing store is `#`-private, so it
 *     does not enumerate under `JSON.stringify` / spread.
 *
 * Since issue #8 the records live behind the {@link RecordStore} persistence port (ADR 0039): the repository
 * passes `context.tenant_id` as the store PARTITION, so the store itself is handed only the partition this
 * layer selected from the minted context (the port has no cross-partition read). The composition root injects
 * the durable SQLite store; the default is a private in-memory store (the test adapter).
 *
 * The lookup key is (tenant_id, id); `id` alone is NEVER a key. Two tenants may therefore hold the
 * same record id with zero collision — each resolves to its own partition's record.
 *
 * related: tenant_context.ts (the brand + liveness predicate), wedding_repository.ts (a typed user),
 * record_store.ts (the persistence port underneath).
 */

/** A record owned by exactly one tenant. The repository compares this field; it never routes by it. */
export interface TenantOwned {
  readonly tenant_id: string
}

export class TenantScopedRepository<T extends TenantOwned> {
  /** The persistence port; partitioned by tenant_id. `#`-private: never enumerates, never serializes. */
  readonly #store: RecordStore
  readonly #collection: Collection<T>

  constructor(
    private readonly liveness: TenantLivenessCheck,
    private readonly idOf: (record: T) => string,
    collection: Collection<T>,
    store: RecordStore = new InMemoryRecordStore(),
  ) {
    // A global collection here would put tenant-owned records in the shared partition: refuse it at wiring time.
    if (collection.scope !== 'tenant') {
      throw new ProductError(
        'PERSISTENCE.INVALID_COLLECTION',
        `TenantScopedRepository needs a tenant-scoped collection; '${collection.name}' is ${collection.scope}.`,
        { context: { collection: collection.name } },
      )
    }
    this.#collection = collection
    this.#store = store
  }

  /** Brand + liveness gate run at the top of every operation. */
  private guard(context: TenantContext): void {
    assertMintedContext(context)
    if (!this.liveness.isUsable(context.tenant_id)) {
      throw new ProductError(
        'PRODUCT.TENANT_NOT_USABLE',
        `Tenant '${context.tenant_id}' is no longer usable; refusing the scoped operation (fail closed).`,
        { context: { tenant_id: context.tenant_id } },
      )
    }
  }

  /** Read a record by id within the context's partition. Foreign/missing id both return `undefined`. */
  read(context: TenantContext, id: string): T | undefined {
    this.guard(context)
    return this.#store.get(this.#collection, context.tenant_id, id)
  }

  /** All records in the context's partition (only ever this tenant's). */
  list(context: TenantContext): readonly T[] {
    this.guard(context)
    return this.#store.list(this.#collection, context.tenant_id)
  }

  /**
   * This tenant's records of one group (keyed with `groupedKey(group_id, id)`): the group, not the whole partition.
   */
  listGroup(context: TenantContext, group_id: string): readonly T[] {
    this.guard(context)
    return this.#store.listByKeyPrefix(this.#collection, context.tenant_id, keyPrefixOf(group_id))
  }

  /**
   * Insert or replace a record. The record's own tenant_id is COMPARED to the context and a mismatch
   * is vetoed (cross-tenant write); the partition is selected by the context, never the payload.
   */
  put(context: TenantContext, record: T): T {
    this.guard(context)
    if (record.tenant_id !== context.tenant_id) {
      throw new ProductError(
        'PRODUCT.CROSS_TENANT_WRITE',
        `Refusing a write carrying tenant_id '${record.tenant_id}' under a context scoped to '${context.tenant_id}'.`,
        { context: { context_tenant_id: context.tenant_id, record_tenant_id: record.tenant_id } },
      )
    }
    this.#store.put(this.#collection, context.tenant_id, this.idOf(record), record)
    return record
  }

  /**
   * Remove a record by id within the context's partition. Returns whether a record existed (so a caller can
   * be idempotent). A foreign/missing id is a no-op returning `false` via the SAME path — no cross-tenant
   * reach (the partition is the context's), no existence oracle.
   */
  delete(context: TenantContext, id: string): boolean {
    this.guard(context)
    return this.#store.delete(this.#collection, context.tenant_id, id)
  }
}
