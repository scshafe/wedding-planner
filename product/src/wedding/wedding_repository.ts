import { type Clock, getSchemaRegistry, type IdGenerator, type Wedding } from '@wedding-planner/shared'

import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical wedding_repository -- tenant-scoped access to the wedding aggregate.
 *
 * A typed facade over {@link TenantScopedRepository}<Wedding>. `create` STAMPS the wedding's
 * tenant_id from the context (a couple/planner cannot inject a foreign tenant_id — there is no
 * tenant_id in the create input), injects wedding_id + created_at from the seeded generators, and
 * validates against the wedding contract. `update` carries the record's own tenant_id, which the
 * scoped repository compares to the context and vetoes on mismatch (PRODUCT.CROSS_TENANT_WRITE) — so
 * neither the create nor the update path can cross the tenant boundary. Reads return `Wedding |
 * undefined` (no existence oracle across tenants).
 *
 * related: tenant_scoped_repository.ts (the isolation boundary), tenant_context.ts.
 */

/** Input to create a wedding. Identity (wedding_id), ownership (tenant_id), and created_at are owned here. */
export interface CreateWeddingInput {
  readonly couple_display_name: string
  readonly event_date: string
  /** Defaults to 'planning'. */
  readonly status?: Wedding['status']
}

export class WeddingRepository {
  private readonly repository: TenantScopedRepository<Wedding>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    this.repository = new TenantScopedRepository<Wedding>(liveness, (wedding) => wedding.wedding_id)
  }

  /** Create a wedding owned by the context's tenant. */
  create(context: TenantContext, input: CreateWeddingInput): Wedding {
    const wedding: Wedding = {
      wedding_id: this.ids.next('wedding'),
      tenant_id: context.tenant_id,
      couple_display_name: input.couple_display_name,
      event_date: input.event_date,
      status: input.status ?? 'planning',
      created_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<Wedding>('wedding', wedding)
    return this.repository.put(context, wedding)
  }

  /** Read a wedding by id within the context's tenant; undefined if absent or owned by another tenant. */
  get(context: TenantContext, wedding_id: string): Wedding | undefined {
    return this.repository.read(context, wedding_id)
  }

  /** All weddings owned by the context's tenant. */
  list(context: TenantContext): readonly Wedding[] {
    return this.repository.list(context)
  }

  /**
   * Replace a wedding. The record carries its own tenant_id; the scoped repository vetoes a write
   * whose tenant_id differs from the context (the cross-tenant update guard).
   */
  update(context: TenantContext, wedding: Wedding): Wedding {
    getSchemaRegistry().assertValid<Wedding>('wedding', wedding)
    return this.repository.put(context, wedding)
  }
}
