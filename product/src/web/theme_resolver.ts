import type { Tenant } from '@wedding-planner/shared'

import { isUsableLifecycle } from '../tenant/tenant_context'
import type { TenantStore } from '../tenant/tenant_store'

/**
 * @canonical theme_resolver -- the lifecycle-gated, theme-only branding lookup for the web edge.
 *
 * Returns a tenant's white-label `theme` ONLY when the tenant exists AND is in a usable ('active')
 * lifecycle state — `undefined` for unknown / onboarding / suspended. This is load-bearing for the
 * no-oracle discipline (doddy P1-1/P1-2, arch P0-1): "theme defined" must be EXACTLY equivalent to
 * "the resolver would mint a context" so that themed-vs-generic rendering never distinguishes an
 * absent tenant from a suspended one. To guarantee that equivalence the predicate here is the SAME
 * `isUsableLifecycle` the `TenantContextResolver` uses (one source of truth, `USABLE_LIFECYCLE_STATUSES`).
 *
 * Deliberately NOT built on `TenantStore.resolveSlug` (which returns the theme WITHOUT a lifecycle
 * check) — that would theme suspended/onboarding tenants and leak existence.
 *
 * Theme-only by construction: it returns just the `theme` value object — no wedding/private reach (the
 * same doddy-P3 reasoning behind `resolveSlug`, lifecycle-gated). The web UI's only DATA path remains
 * `api.handle()`; this resolver only supplies branding.
 *
 * related: tenant_context.ts (the identical predicate), product_web_ui.ts (themes only the 200/401 path).
 */
export class ThemeResolver {
  constructor(private readonly store: TenantStore) {}

  /** The active tenant's theme, or undefined for unknown/onboarding/suspended (no existence oracle). */
  resolveActiveTheme(slug: string): Tenant['theme'] | undefined {
    const tenant = this.store.findBySlug(slug)
    if (tenant === undefined || !isUsableLifecycle(tenant.lifecycle_status)) return undefined
    return tenant.theme
  }
}
