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

// The product aggregates (generated from product/schemas/*, surfaced via shared's clean-named types).
export type { Tenant, Wedding } from '@wedding-planner/shared'

// Tenant isolation boundary. The brand symbol and the internal mint are deliberately NOT exported —
// the resolver is the sole mint of a TenantContext.
export {
  type TenantContext,
  TenantContextResolver,
  assertMintedContext,
  isUsableLifecycle,
  USABLE_LIFECYCLE_STATUSES,
} from './tenant/tenant_context'
export {
  TenantStore,
  type TenantLivenessCheck,
  type TenantRouting,
  type CreateTenantInput,
  normalizeSlug,
} from './tenant/tenant_store'
export { TenantScopedRepository, type TenantOwned } from './tenant/tenant_scoped_repository'

// The wedding aggregate, tenant-scoped.
export { WeddingRepository, type CreateWeddingInput } from './wedding/wedding_repository'

// Intra-tenant authorization: the Principal (planner vs couple) and the session mint. The brand symbol
// and the internal mintPrincipal are deliberately NOT exported — the SessionStore is the sole mint.
export { type Principal, type PrincipalRole, assertMintedPrincipal } from './auth/principal'
export { SessionStore, type LoginInput, type Session } from './auth/session_store'
