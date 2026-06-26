import { type Clock, getSchemaRegistry, type IdGenerator, type Tenant } from '@wedding-planner/shared'

import { ProductError } from '../product_error'
import { isUsableLifecycle } from './tenant_context'

/**
 * @canonical tenant_store -- the registry of tenants and the global slug index.
 *
 * Owns tenant creation (id + created_at injected, never ambient), the GLOBAL slug-uniqueness
 * invariant (the white-label routing key resolves slug -> tenant), and the liveness check the
 * tenant-scoped repository asserts on every operation. Tenant records hold only routing + branding +
 * lifecycle metadata — NO wedding or per-couple data — so slug resolution is not a back-door to a
 * tenant's private data (doddy P3). Backing maps are `#`-private: they do not enumerate, so
 * `JSON.stringify` / spread of the store reveals no tenant data.
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
  readonly #byId = new Map<string, Tenant>()
  readonly #idByNormalizedSlug = new Map<string, string>()

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Create and register a tenant. Throws PRODUCT.DUPLICATE_SLUG on a (normalized) slug collision. */
  create(input: CreateTenantInput): Tenant {
    const slug = normalizeSlug(input.slug)
    if (this.#idByNormalizedSlug.has(slug)) {
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
    this.#byId.set(tenant.tenant_id, tenant)
    this.#idByNormalizedSlug.set(slug, tenant.tenant_id)
    return tenant
  }

  /** Resolve a slug to its full tenant record (used by the resolver, which needs lifecycle_status). */
  findBySlug(slug: string): Tenant | undefined {
    const id = this.#idByNormalizedSlug.get(normalizeSlug(slug))
    return id === undefined ? undefined : this.#byId.get(id)
  }

  /** Look up a tenant by id. */
  findById(tenant_id: string): Tenant | undefined {
    return this.#byId.get(tenant_id)
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
    const tenant = this.#byId.get(tenant_id)
    return tenant !== undefined && isUsableLifecycle(tenant.lifecycle_status)
  }

  /**
   * Transition a tenant's simulated lifecycle state (e.g. activate after onboarding, or suspend).
   * The change takes effect immediately for liveness — a context minted while active stops working
   * the instant the tenant is suspended.
   */
  setLifecycleStatus(tenant_id: string, status: Tenant['lifecycle_status']): Tenant {
    const tenant = this.#byId.get(tenant_id)
    if (tenant === undefined) {
      throw new ProductError(
        'PRODUCT.UNKNOWN_TENANT',
        `No tenant '${tenant_id}' to transition.`,
        { context: { tenant_id } },
      )
    }
    const updated: Tenant = { ...tenant, lifecycle_status: status }
    getSchemaRegistry().assertValid<Tenant>('tenant', updated)
    this.#byId.set(tenant_id, updated)
    return updated
  }
}
