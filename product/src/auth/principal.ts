import { ProductError } from '../product_error'

/**
 * @canonical principal -- the unforgeable intra-tenant authorization subject.
 *
 * A Principal is the *resolved* identity of WHO is acting within one tenant: a `planner` (the tenant's
 * staff, who may act on every wedding in the tenant) or a `couple` (bound to exactly ONE wedding, who
 * may act only on their own). It is the second of the two stacked product-surface boundaries — the
 * INTRA-tenant gate the inter-tenant `TenantContext` (Phase 12) deliberately deferred. The two are
 * symmetric: a TenantContext can never cross to another tenant; a Principal can never cross to another
 * wedding within its tenant.
 *
 * Unforgeability is enforced by CONSTRUCTION, exactly as for TenantContext (and for the same reason
 * doddy proved there): the authorizer is a reusable component that future request code / tests can
 * call with a hand-built `as Principal`, and a forged `couple` naming a different `wedding_id` would
 * be an intra-tenant escalation the tenant context cannot stop. So a Principal carries:
 *
 *   1. A compile-time phantom brand (a `declare`d `unique symbol` member — type-system only, never a
 *      runtime property), so a structural `{ tenant_id, role }` literal is not assignable.
 *   2. A runtime IDENTITY token: a module-private `WeakSet` the mint adds each principal to;
 *      `assertMintedPrincipal` checks membership. Membership lives OUTSIDE the object, so there is
 *      nothing to reflect with `Object.getOwnPropertySymbols` and re-stamp onto a forged object (the
 *      re-stamp attack the earlier symbol-property brand was vulnerable to — see tenant_context.ts).
 *
 * The minted principal is `Object.freeze`d. The SessionStore (`session_store.ts`) is the SOLE mint —
 * the analogue of "the resolver is the sole mint of a TenantContext". The brand symbol and `mintPrincipal`
 * are never exported from the barrel.
 *
 * related: session_store.ts (the sole mint), wedding_authorizer.ts (asserts the brand at entry),
 * tenant_context.ts (the inter-tenant analogue this mirrors).
 */

/** The two roles in the intra-tenant model: tenant staff vs. a single couple. */
export type PrincipalRole = 'planner' | 'couple'

/**
 * Compile-time phantom brand. `declare const` means it exists ONLY in the type system — there is no
 * runtime symbol, so nothing is reflectable on a minted principal. Its key is unnameable outside this
 * module, giving Principal nominal typing.
 */
declare const PRINCIPAL_BRAND: unique symbol

/** The resolved identity of who is acting within one tenant. */
export interface Principal {
  readonly tenant_id: string
  readonly role: PrincipalRole
  /**
   * Present iff `role === 'couple'` — the single wedding this couple is bound to. Carried opaquely
   * from login (NOT verified to exist there — that would be an existence oracle); a phantom or foreign
   * id simply reads back the masked not-found at use. The binding cannot go stale: weddings are never
   * deleted or reassigned, and a wedding's `wedding_id`/`tenant_id` are immutable.
   */
  readonly wedding_id?: string
  readonly principal_id: string
  /** Phantom brand for nominal typing — never an actual runtime property (see PRINCIPAL_BRAND). */
  readonly [PRINCIPAL_BRAND]: true
}

/**
 * The runtime identity token. A principal is "minted" iff it is a member of this set. Membership is by
 * object identity and lives OUTSIDE the object, so it cannot be reflected off a real principal and
 * copied onto a forged one.
 */
const MINTED_PRINCIPALS = new WeakSet<Principal>()

/**
 * Assert that `principal` was minted by the SessionStore (carries the private brand). A hand-built or
 * cast object lacks the unnameable brand key and is rejected. Called at the top of every authorizer
 * decision — the runtime half of the unforgeability guarantee.
 */
export function assertMintedPrincipal(principal: Principal): void {
  if (!MINTED_PRINCIPALS.has(principal)) {
    throw new ProductError(
      'PRODUCT.FORGED_PRINCIPAL',
      'Principal was not minted by the SessionStore; refusing to authorize against it.',
      {},
    )
  }
}

/** The fields a mint supplies (everything but the brand, which the mint stamps). */
export interface MintPrincipalInput {
  readonly tenant_id: string
  readonly role: PrincipalRole
  readonly wedding_id?: string
  readonly principal_id: string
}

/**
 * Internal mint — the ONLY place a principal joins the minted set. Freezes it against post-hoc
 * mutation. Exported for use by `session_store.ts` ONLY; never re-exported from the package barrel.
 */
export function mintPrincipal(input: MintPrincipalInput): Principal {
  const principal = Object.freeze({
    tenant_id: input.tenant_id,
    role: input.role,
    // Only attach wedding_id when present, so a planner principal carries no own wedding_id key at all.
    ...(input.wedding_id === undefined ? {} : { wedding_id: input.wedding_id }),
    principal_id: input.principal_id,
  }) as unknown as Principal
  MINTED_PRINCIPALS.add(principal)
  return principal
}
