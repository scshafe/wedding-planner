import { type Clock, getSchemaRegistry, type IdGenerator, type Tenant } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import { isUsableLifecycle } from './tenant_context'

/**
 * @canonical tenant_store -- the registry of tenants and the global slug index.
 *
 * Owns tenant creation (id + created_at injected, never ambient), the GLOBAL slug-uniqueness
 * invariant (the white-label routing key resolves slug -> tenant), and the liveness check the
 * tenant-scoped repository asserts on every operation. Tenant records hold only routing + branding +
 * lifecycle metadata — NO wedding or per-couple data — so slug resolution is not a back-door to a
 * tenant's private data (doddy P3). The backing store is `#`-private: it does not enumerate, so
 * `JSON.stringify` / spread of the store reveals no tenant data. Since issue #8 tenants and the slug index live
 * behind the {@link RecordStore} port in the global partition (two collections, written in one transaction).
 *
 * Slug uniqueness is enforced on the NORMALIZED form (lowercase) so 'Acme' and 'acme' cannot fork a
 * tenant. The schema `pattern` pins the rest of the normal form ([a-z0-9-], no edge hyphen).
 *
 * related: tenant_context.ts (resolver mints from findBySlug; usability predicate), tenant_scoped_repository.ts.
 */

/** Non-secret routing metadata exposed by slug resolution — deliberately excludes nothing private (there is none). */
export interface TenantRouting {
  readonly tenant_id: string
  readonly slug: string
  readonly theme: Tenant['theme']
}

/** Input to create a tenant. tenant_id, slug normalization, and created_at are owned by the store. */
export interface CreateTenantInput {
  readonly slug: string
  readonly display_name: string
  readonly theme: Tenant['theme']
  readonly plan_tier: Tenant['plan_tier']
  /** Defaults to 'onboarding' (a freshly-created tenant is not yet usable until activated). */
  readonly lifecycle_status?: Tenant['lifecycle_status']
}

/** Normalize a slug to its canonical (lowercase) form; the schema pattern enforces the remaining shape. */
export function normalizeSlug(slug: string): string {
  return slug.toLowerCase()
}

/** The liveness surface the tenant-scoped repository depends on (asserted at every operation). */
export interface TenantLivenessCheck {
  isUsable(tenant_id: string): boolean
}

export class TenantStore implements TenantLivenessCheck {
  readonly #store: RecordStore

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
  ) {
    this.#store = store
  }

  /** Create and register a tenant. Throws PRODUCT.DUPLICATE_SLUG on a (normalized) slug collision. */
  create(input: CreateTenantInput): Tenant {
    const slug = normalizeSlug(input.slug)
    if (this.#store.get(COLLECTIONS.tenantSlug, GLOBAL_PARTITION, slug) !== undefined) {
      throw new ProductError(
        'PRODUCT.DUPLICATE_SLUG',
        `A tenant with slug '${slug}' already exists.`,
        { context: { slug } },
      )
    }
    const tenant: Tenant = {
      tenant_id: this.ids.next('tenant'),
      slug,
      display_name: input.display_name,
      theme: input.theme,
      plan_tier: input.plan_tier,
      lifecycle_status: input.lifecycle_status ?? 'onboarding',
      created_at: this.clock.now(),
    }
    // Validate against the canonical contract (catches a malformed slug/theme/colors before it lands).
    getSchemaRegistry().assertValid<Tenant>('tenant', tenant)
    this.#store.transaction(() => {
      this.#store.put(COLLECTIONS.tenant, GLOBAL_PARTITION, tenant.tenant_id, tenant)
      this.#store.put(COLLECTIONS.tenantSlug, GLOBAL_PARTITION, slug, { tenant_id: tenant.tenant_id })
    })
    return tenant
  }

  /** Resolve a slug to its full tenant record (used by the resolver, which needs lifecycle_status). */
  findBySlug(slug: string): Tenant | undefined {
    const index = this.#store.get(COLLECTIONS.tenantSlug, GLOBAL_PARTITION, normalizeSlug(slug))
    return index === undefined ? undefined : this.findById(index.tenant_id)
  }

  /** Look up a tenant by id. */
  findById(tenant_id: string): Tenant | undefined {
    return this.#store.get(COLLECTIONS.tenant, GLOBAL_PARTITION, tenant_id)
  }

  /** Every tenant, in creation order (the operator's tenant list). */
  list(): readonly Tenant[] {
    return this.#store.list(COLLECTIONS.tenant, GLOBAL_PARTITION)
  }

  /** Whether no tenant exists yet (the demo seed runs only into an empty store). */
  isEmpty(): boolean {
    return this.#store.isEmpty(COLLECTIONS.tenant)
  }

  /**
   * Routing-only resolution: the non-secret data a future request router needs to theme a page,
   * with no path to wedding/private data (doddy P3). Returns undefined for an unknown slug.
   */
  resolveSlug(slug: string): TenantRouting | undefined {
    const tenant = this.findBySlug(slug)
    if (tenant === undefined) return undefined
    return { tenant_id: tenant.tenant_id, slug: tenant.slug, theme: tenant.theme }
  }

  /** Liveness: whether this tenant currently exists and may transact. Re-checked at every repo op. */
  isUsable(tenant_id: string): boolean {
    const tenant = this.findById(tenant_id)
    return tenant !== undefined && isUsableLifecycle(tenant.lifecycle_status)
  }

  /**
   * Transition a tenant's simulated lifecycle state (e.g. activate after onboarding, or suspend).
   * The change takes effect immediately for liveness — a context minted while active stops working
   * the instant the tenant is suspended.
   */
  setLifecycleStatus(tenant_id: string, status: Tenant['lifecycle_status']): Tenant {
    const tenant = this.findById(tenant_id)
    if (tenant === undefined) {
      throw new ProductError(
        'PRODUCT.UNKNOWN_TENANT',
        `No tenant '${tenant_id}' to transition.`,
        { context: { tenant_id } },
      )
    }
    const updated: Tenant = { ...tenant, lifecycle_status: status }
    getSchemaRegistry().assertValid<Tenant>('tenant', updated)
    this.#store.put(COLLECTIONS.tenant, GLOBAL_PARTITION, tenant_id, updated)
    return updated
  }
}
