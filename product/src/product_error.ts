import { WeddingPlannerError } from '@wedding-planner/shared'

/**
 * @canonical product_error -- the error type for the customer-facing product domain.
 *
 * Codes are PRODUCT.<FAILURE_MODE>. The tenant-isolation boundary and the request edge raise these
 * structured, machine-routable failures rather than leaking ad-hoc strings:
 *   - PRODUCT.UNKNOWN_TENANT          no tenant resolves for the given slug
 *   - PRODUCT.TENANT_NOT_USABLE       the tenant exists but its lifecycle state forbids use (fail closed)
 *   - PRODUCT.FORGED_CONTEXT          a TenantContext reached the repository without the resolver's brand
 *   - PRODUCT.CROSS_TENANT_WRITE      a write carried a tenant_id other than the context's
 *   - PRODUCT.DUPLICATE_SLUG          a tenant slug collided with an existing one (normalized)
 *   - PRODUCT.VALIDATION_FAILED       an aggregate failed its JSON Schema contract
 *   - PRODUCT.NO_SESSION              a request carried no / an unknown session token (unauthenticated)
 *   - PRODUCT.SESSION_TENANT_MISMATCH a session minted for tenant A was presented on tenant B's route
 *   - PRODUCT.FORBIDDEN              a principal lacks the capability for an op (e.g. a couple creating)
 *   - PRODUCT.FORGED_PRINCIPAL       a Principal reached the authorizer without the SessionStore's brand
 *   - PRODUCT.BAD_REQUEST            a malformed request (unparseable body, missing required field)
 *   - PRODUCT.ROUTE_NOT_FOUND        no route matches the request path
 *   - PRODUCT.METHOD_NOT_ALLOWED     the path is known but the method is not
 *   - PRODUCT.NO_OPERATOR            an /admin request carried no / an unknown operator token (Phase 15)
 *   - PRODUCT.FORGED_OPERATOR        an Operator reached a check without the OperatorCredentialStore's brand
 *   - PRODUCT.DUPLICATE_OPERATOR_TOKEN two seeded operator credential tokens collided
 *   - PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION an onboarding op asked for an illegal lifecycle edge (Phase 15)
 *   - PRODUCT.PROVIDER_COST_INVALID   a messaging provider reported a non-integer/negative per-message cost
 *                                     (untrusted-edge invariant; fail closed before metering — Phase 18)
 *   - PRODUCT.MARGIN_VIOLATION        a tenant message price did not strictly exceed the provider COGS
 *                                     (we never knowingly sell messaging at a loss; fail closed — Phase 18)
 *   - PRODUCT.NO_WEBHOOK_CREDENTIAL   an inbound webhook carried no / an unknown provider token (Phase 19;
 *                                     → constant 401, the fourth token namespace, peer of NO_OPERATOR)
 *   - PRODUCT.FORGED_WEBHOOK_PROVIDER a credential reached a check without the store's brand (Phase 19)
 *   - PRODUCT.DUPLICATE_WEBHOOK_TOKEN two seeded provider webhook tokens collided (Phase 19)
 *   - PRODUCT.GUEST_ALREADY_REGISTERED a planner registered a recipient_ref already bound under the tenant
 *                                     (Phase 21; → honest 409 to the trusted planner, NOT masked — like
 *                                     DUPLICATE_SLUG, the absent-vs-suspended mask is an anonymous-edge property)
 *
 * The read path deliberately raises NOTHING for a not-found / cross-tenant id — it returns a
 * value-level `undefined` so a foreign id is indistinguishable from a missing one (no existence
 * oracle). The intra-tenant authorizer extends this: a couple addressing a non-owned wedding yields the
 * SAME masked not-found as a missing one (no intra-tenant oracle). Only caller bugs (forged
 * context/principal, cross-tenant write) and invariant violations throw at the domain layer; at the
 * request edge, errorToResponse maps every code to a code-free HTTP response.
 *
 * related: shared WeddingPlannerError (base type).
 */
export class ProductError extends WeddingPlannerError {}
