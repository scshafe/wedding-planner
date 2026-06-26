/* eslint-disable */
/**
 * GENERATED from product/schemas/tenant_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A wedding-planner organization — the white-label customer of the multi-tenant product surface. The tenant is the unit of isolation: every wedding and all product data is partitioned by tenant_id, and a TenantContext minted for one tenant can never reach another's data. Onboarding/billing are offline simulations (plan_tier, lifecycle_status are modeled fields, not real charges). See product/README.md.
 */
export interface Tenant {
/**
 * Stable internal identity, injected from the id generator (never ambient). Never used as a cross-tenant lookup key on its own — the lookup key is (tenant_id, id).
 */
tenant_id: string
/**
 * The globally-unique, normalized white-label routing key (lowercase, [a-z0-9-], no leading/trailing hyphen). The future request router resolves slug -> tenant; uniqueness is enforced on this normalized form so case/homograph variants cannot fork a tenant. Non-secret routing metadata.
 */
slug: string
/**
 * The planner organization's human-readable name.
 */
display_name: string
/**
 * White-label branding. A value object owned wholly by the tenant (no independent identity or lifecycle); modeled here, rendered in a later phase.
 */
theme: {
/**
 * The brand shown to couples (may differ from display_name).
 */
brand_name: string
/**
 * Primary brand color, lowercase 6-digit hex.
 */
primary_color_hex: string
/**
 * Accent brand color, lowercase 6-digit hex.
 */
accent_color_hex: string
/**
 * An offline asset reference for the logo (no real upload/CDN; a local reference id).
 */
logo_ref: string
}
/**
 * Simulated billing tier (no real money). solo = single planner; studio = small team; agency = multi-planner.
 */
plan_tier: ("solo" | "studio" | "agency")
/**
 * Simulated onboarding/billing state. The resolver's usability predicate is a function of this: only 'active' tenants mint a usable TenantContext; 'onboarding'/'suspended' fail closed (PRODUCT.TENANT_NOT_USABLE).
 */
lifecycle_status: ("onboarding" | "active" | "suspended")
/**
 * ISO 8601 UTC creation time, from the injected clock (never ambient).
 */
created_at: string
}
