import { assertMintedPrincipal, type Principal } from './principal'
import type { AccessDecision } from './wedding_authorizer'

/**
 * @canonical guest_authorizer -- the intra-tenant authorization rules for the guest-management surface.
 *
 * Guest management splits into a CAPABILITY decision and a RESOURCE scope, mirroring the couple-vs-planner
 * split in wedding_authorizer.ts one domain over:
 *
 *   - `register` is **planner-only** (`authorizeRegister`). It stays a capability a couple lacks ENTIRELY
 *     (`forbidden` -> 403) — NOT because a couple shouldn't add their own guests, but because the registry
 *     keys guests by a tenant-GLOBAL `recipient_ref`: registering a ref already bound to ANOTHER wedding
 *     throws `PRODUCT.GUEST_ALREADY_REGISTERED` (409), a cross-wedding existence oracle a couple-scoped list
 *     can't cross-reference away. So couple-register is a documented deferral (see guest_registry.ts), and the
 *     403 is checked BEFORE the body is parsed so a malformed couple body can't distinguish anything.
 *   - `list` / `remove` are **scoped** (`manageScope`): a planner manages the whole tenant partition
 *     (`{ kind: 'all' }`); a couple manages only the guests of the single wedding they are bound to
 *     (`{ kind: 'wedding', wedding_id }`, derived ONLY from `principal.wedding_id` — never the request body).
 *     The wedding_id compare is the segmentation gate; both scoped registry ops are oracle-free (a couple's
 *     list shows only their wedding's guests; a couple's remove no-ops byte-identically on an absent /
 *     sibling-wedding / foreign-tenant ref — see guest_registry.ts).
 *
 * It NEVER throws for an authorization OUTCOME (it returns a decision/scope value); the only throw is
 * `assertMintedPrincipal` at entry — a forged/cast principal is an invariant violation, not an authz outcome.
 * Pure: no clock, no store, no I/O. The handler combines the decision/scope with the tenant-scoped registry.
 *
 * related: wedding_authorizer.ts (the AccessDecision/ListScope vocabulary this mirrors),
 * guest_registry.ts (the tenant-scoped store + the scope-aware list/remove the handler combines this with).
 */

/**
 * How guest list/remove is scoped for a principal.
 *   - `{ kind: 'all' }`                a planner manages the whole tenant partition
 *   - `{ kind: 'wedding', wedding_id }` a couple manages only their bound wedding's guests
 *
 * NOTE — divergence from wedding_authorizer's `ListScope`: `wedding_id` is `string | undefined`, but the
 * `undefined` collapse to an empty/no-op result lives ONLY inside the registry methods
 * (`listForWedding`/`removeForWedding`), NOT in the handler. Guest list is a partition FILTER (not a
 * zero-or-one probe), so an absent wedding_id naturally yields `[]`/`false` there — the handler is a pure
 * two-arm `kind` branch and must not re-check `undefined` (unlike `handleList`, whose registry has no
 * wedding-scoped method).
 */
export type GuestScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'wedding'; readonly wedding_id: string | undefined }

export class GuestAuthorizer {
  /** Register a guest. Planner only; a couple lacks the capability entirely (-> 403). See the header for why. */
  authorizeRegister(principal: Principal): AccessDecision {
    assertMintedPrincipal(principal)
    return principal.role === 'planner' ? 'allow' : 'forbidden'
  }

  /**
   * View the tenant's billing & usage summary (Phase 30). Planner only — billing is a TENANT-ACCOUNT capability
   * (not a per-wedding resource), so a couple lacks it ENTIRELY (`forbidden` -> 403), exactly like
   * {@link authorizeRegister}. Because no specific resource is being probed (the account IS the whole tenant), the
   * 403 is no existence oracle; the handler checks it BEFORE the method branch, so a couple cannot distinguish
   * methods either. This authorizer is the intra-tenant MANAGEMENT-capability home (it already owns
   * `authorizeRegister` + the `manageScope` reused by the escalation inbox), so the account-level billing
   * capability fits here rather than on the wedding-resource authorizer. Returns a decision — never throws.
   */
  authorizeBillingView(principal: Principal): AccessDecision {
    assertMintedPrincipal(principal)
    return principal.role === 'planner' ? 'allow' : 'forbidden'
  }

  /** How to scope list/remove for this principal (planner: whole tenant; couple: their bound wedding). */
  manageScope(principal: Principal): GuestScope {
    assertMintedPrincipal(principal)
    if (principal.role === 'planner') return { kind: 'all' }
    return { kind: 'wedding', wedding_id: principal.wedding_id }
  }
}
