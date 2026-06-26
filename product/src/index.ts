/**
 * @wedding-planner/product — the customer-facing product surface.
 *
 * Public barrel. The white-label, multi-tenant web app planners and their couples use, built
 * offline-first. Phase 12 builds the multi-tenant domain core: the tenant + wedding aggregates and
 * the tenant-isolation boundary (the multi-tenancy analogue of the trusted-evidence firewall).
 * HTTP, auth principals, UI, onboarding/billing simulation, and Docker packaging land in later
 * phases. This barrel deliberately does NOT export the TenantContext brand symbol or any context
 * constructor — the resolver is the sole mint (see tenant_context.ts).
 */

export const PRODUCT_PACKAGE_NAME = '@wedding-planner/product'

export { ProductError } from './product_error'
