import { assertMintedPrincipal, type Principal } from './principal'

/**
 * @canonical wedding_authorizer -- the intra-tenant authorization rules + the no-oracle masking.
 *
 * Given a (branded) Principal, decides each wedding operation within the principal's tenant. It is the
 * intra-tenant analogue of the inter-tenant isolation boundary, and it carries the SAME no-existence-
 * oracle discipline one layer up:
 *
 *   - A couple may act only on the single wedding they are bound to. Ownership is decided STRUCTURALLY
 *     from `principal.wedding_id`, BEFORE and INDEPENDENT of any repository lookup — so "exists but not
 *     yours" and "doesn't exist" are the same path. A non-owned id yields `mask-not-found`, which the
 *     handler renders as the byte-identical `404` a missing id produces. Even the couple's OWN id, when
 *     genuinely absent, reads back the same `404` (the handler maps an `allow` + `undefined` record to
 *     the same constant) — masking holds from the own-missing direction too.
 *   - A capability the role simply lacks (a couple creating a wedding) yields `forbidden` (`403`) — no
 *     oracle concern, because no specific resource is being probed.
 *
 * The authorizer NEVER throws for an authorization OUTCOME (it returns a decision value), so the masked
 * path can never trip the `500` forged-invariant backstop. The only throw is `assertMintedPrincipal` at
 * entry — a forged/cast principal is an invariant violation, not an authz outcome.
 *
 * Pure: no clock, no store, no I/O. The handler combines the decision with the tenant-scoped repository.
 *
 * related: principal.ts (the brand), product_api.ts (the handler that renders decisions to responses).
 */

/**
 * The outcome of an authorization check.
 *   - `allow`          proceed (for a couple read/update this means the id IS their bound wedding; the
 *                      record may still be absent, which the handler renders as the same masked 404)
 *   - `mask-not-found` deny WITHOUT revealing existence — rendered as the byte-identical 404 of a miss
 *   - `forbidden`      a capability the role lacks entirely — rendered as 403
 */
export type AccessDecision = 'allow' | 'mask-not-found' | 'forbidden'

/**
 * How `list` is scoped for a principal.
 *   - `{ kind: 'all' }`               a planner sees the whole tenant partition
 *   - `{ kind: 'single', wedding_id }` a couple sees only their bound wedding (zero-or-one), derived
 *                                      ONLY from the principal — never by pulling the partition and filtering
 */
export type ListScope = { readonly kind: 'all' } | { readonly kind: 'single'; readonly wedding_id: string | undefined }

export class WeddingAuthorizer {
  /** Create a wedding. Planner only; a couple lacks the capability entirely (capability denial -> 403). */
  authorizeCreate(principal: Principal): AccessDecision {
    assertMintedPrincipal(principal)
    return principal.role === 'planner' ? 'allow' : 'forbidden'
  }

  /** Read a wedding by id. Planner: any in tenant. Couple: own -> allow; non-owned -> masked (no probe). */
  authorizeRead(principal: Principal, wedding_id: string): AccessDecision {
    return this.#authorizeResourceAccess(principal, wedding_id)
  }

  /** Update a wedding by id. Same resource-scoping as read (a couple may only touch their own). */
  authorizeUpdate(principal: Principal, wedding_id: string): AccessDecision {
    return this.#authorizeResourceAccess(principal, wedding_id)
  }

  /** How to scope a list for this principal (planner: all; couple: their single bound wedding). */
  listScope(principal: Principal): ListScope {
    assertMintedPrincipal(principal)
    if (principal.role === 'planner') return { kind: 'all' }
    return { kind: 'single', wedding_id: principal.wedding_id }
  }

  /**
   * The shared couple-vs-planner resource decision. A couple's ownership is decided structurally from
   * `principal.wedding_id` with NO repository lookup, so a non-owned id is indistinguishable from a
   * missing one. A planner is allowed any id in their tenant.
   */
  #authorizeResourceAccess(principal: Principal, wedding_id: string): AccessDecision {
    assertMintedPrincipal(principal)
    if (principal.role === 'planner') return 'allow'
    // Couple: structural ownership check, no existence probe.
    return principal.wedding_id !== undefined && principal.wedding_id === wedding_id
      ? 'allow'
      : 'mask-not-found'
  }
}
