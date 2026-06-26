import { ProductError } from '../product_error'
import { assertMintedContext, type TenantContext } from './tenant_context'
import type { TenantLivenessCheck } from './tenant_store'

/**
 * @canonical tenant_scoped_repository -- the physical tenant-isolation boundary.
 *
 * A generic in-memory store partitioned by tenant. EVERY read/list/write takes a {@link TenantContext}
 * and the partition is selected by `context.tenant_id` ALONE — never by a tenant_id read from a
 * payload or passed as a separate argument (inv. 4). The isolation guarantees, by construction:
 *
 *   - Each op first runs `assertMintedContext` (rejects a forged/cast context, PRODUCT.FORGED_CONTEXT)
 *     then re-asserts the tenant is still usable (liveness at use, fail closed — a context held past a
 *     suspension stops working: PRODUCT.TENANT_NOT_USABLE). The context carries no cached authority.
 *   - `read` returns `T | undefined`: a foreign-tenant id and a never-existed id return the
 *     byte-identical `undefined` via the SAME code path, with no side effect — no existence oracle.
 *   - `list` returns only the context partition's records, ever.
 *   - `put` stamps nothing; it COMPARES `record.tenant_id` to the context and vetoes a mismatch
 *     (PRODUCT.CROSS_TENANT_WRITE) on create and update alike. The payload field is compare-only.
 *   - There is NO unscoped / all-tenants accessor (inv. 9), and the backing partition map is
 *     `#`-private, so it does not enumerate under `JSON.stringify` / spread.
 *
 * The lookup key is (tenant_id, id); `id` alone is NEVER a key. Two tenants may therefore hold the
 * same record id with zero collision — each resolves to its own partition's record.
 *
 * related: tenant_context.ts (the brand + liveness predicate), wedding_repository.ts (a typed user).
 */

/** A record owned by exactly one tenant. The repository compares this field; it never routes by it. */
export interface TenantOwned {
  readonly tenant_id: string
}

export class TenantScopedRepository<T extends TenantOwned> {
  /** tenant_id -> (record_id -> record). `#`-private: never enumerates, never serializes. */
  readonly #partitions = new Map<string, Map<string, T>>()

  constructor(
    private readonly liveness: TenantLivenessCheck,
    private readonly idOf: (record: T) => string,
  ) {}

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

  /** Read-only partition accessor: returns undefined when the tenant has no partition (no mutation on read). */
  #readPartition(context: TenantContext): Map<string, T> | undefined {
    return this.#partitions.get(context.tenant_id)
  }

  /** Read a record by id within the context's partition. Foreign/missing id both return `undefined`. */
  read(context: TenantContext, id: string): T | undefined {
    this.guard(context)
    return this.#readPartition(context)?.get(id)
  }

  /** All records in the context's partition (only ever this tenant's). */
  list(context: TenantContext): readonly T[] {
    this.guard(context)
    const partition = this.#readPartition(context)
    return partition === undefined ? [] : [...partition.values()]
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
    let partition = this.#partitions.get(context.tenant_id)
    if (partition === undefined) {
      partition = new Map<string, T>()
      this.#partitions.set(context.tenant_id, partition)
    }
    partition.set(this.idOf(record), record)
    return record
  }
}
