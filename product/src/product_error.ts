import { WeddingPlannerError } from '@wedding-planner/shared'

/**
 * @canonical product_error -- the error type for the customer-facing product domain.
 *
 * Codes are PRODUCT.<FAILURE_MODE>. The tenant-isolation boundary raises these structured,
 * machine-routable failures rather than leaking ad-hoc strings:
 *   - PRODUCT.UNKNOWN_TENANT      no tenant resolves for the given slug
 *   - PRODUCT.TENANT_NOT_USABLE   the tenant exists but its lifecycle state forbids use (fail closed)
 *   - PRODUCT.FORGED_CONTEXT      a TenantContext reached the repository without the resolver's brand
 *   - PRODUCT.CROSS_TENANT_WRITE  a write carried a tenant_id other than the context's
 *   - PRODUCT.DUPLICATE_SLUG      a tenant slug collided with an existing one (normalized)
 *   - PRODUCT.VALIDATION_FAILED   an aggregate failed its JSON Schema contract
 *
 * The read path deliberately raises NOTHING for a not-found / cross-tenant id — it returns a
 * value-level `undefined` so a foreign id is indistinguishable from a missing one (no existence
 * oracle). Only caller bugs (forged context, cross-tenant write) and invariant violations throw.
 *
 * related: shared WeddingPlannerError (base type).
 */
export class ProductError extends WeddingPlannerError {}
