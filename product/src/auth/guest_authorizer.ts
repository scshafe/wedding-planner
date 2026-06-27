import { assertMintedPrincipal, type Principal } from './principal'
import type { AccessDecision } from './wedding_authorizer'

/**
 * @canonical guest_authorizer -- the intra-tenant authorization rule for the guest-management surface.
 *
 * Guest management (register / list / remove) is **planner-only**: a planner is workspace staff for the whole
 * tenant, so they may manage any guest in it; a couple lacks the capability entirely. This is a pure CAPABILITY
 * decision — it probes no specific resource, so a denial is a `forbidden` (rendered 403), never a masked
 * not-found. (Guests are keyed by an opaque recipient_ref, not owned by a couple, so there is no couple-scoped
 * resource decision here — contrast wedding_authorizer.ts, where a couple owns exactly one wedding.)
 *
 * It NEVER throws for an authorization OUTCOME (it returns a decision value); the only throw is
 * `assertMintedPrincipal` at entry — a forged/cast principal is an invariant violation, not an authz outcome.
 * Pure: no clock, no store, no I/O. A couple managing their OWN wedding's guests is a documented future
 * refinement, not this rung.
 *
 * related: wedding_authorizer.ts (the AccessDecision vocabulary + the couple-vs-planner resource analogue),
 * guest_registry.ts (the tenant-scoped store the handler combines this decision with).
 */
export class GuestAuthorizer {
  /** Manage guests (register/list/remove). Planner only; a couple lacks the capability entirely (-> 403). */
  authorizeManage(principal: Principal): AccessDecision {
    assertMintedPrincipal(principal)
    return principal.role === 'planner' ? 'allow' : 'forbidden'
  }
}
