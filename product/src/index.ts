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

// The simulated billing ledger (Phase 15): the offline model that drives the tenant lifecycle. No real
// money — amount_cents are modeled, integer cents. The 'account balance' is a fold over events.
export type { BillingEvent } from '@wedding-planner/shared'
export { MONTHLY_PRICE_CENTS, monthlyPriceCents, type PlanTier } from './billing/price_book'
export {
  BillingLedger,
  type BillingEventKind,
  type RecordBillingEventInput,
} from './billing/billing_ledger'

// Intra-tenant authorization: the Principal (planner vs couple) and the session mint. The brand symbol
// and the internal mintPrincipal are deliberately NOT exported — the SessionStore is the sole mint.
export { type Principal, type PrincipalRole, assertMintedPrincipal } from './auth/principal'
export { SessionStore, type LoginInput, type Session } from './auth/session_store'
export {
  WeddingAuthorizer,
  type AccessDecision,
  type ListScope,
} from './auth/wedding_authorizer'

// The HTTP request edge (transport-agnostic). The Node socket adapter lands in Step 4.
export type { ApiRequest, ApiResponse } from './http/api_message'
export {
  ProductApi,
  type ProductApiDeps,
  type WeddingHandlerDeps,
} from './http/product_api'
export { createProductApiServer, MAX_BODY_BYTES } from './http/node_server'

// The server-rendered web UI (Phase 14): the themed white-label HTML front door over the JSON pipeline.
// It holds only { api, themes } — its sole data path is api.handle(), so it inherits both boundaries.
export type { HttpResult } from './web/web_response'
export { ThemeResolver } from './web/theme_resolver'
export { ProductWebUi, type ProductWebUiDeps } from './web/product_web_ui'
export { createProductWebUiServer } from './web/web_server'
