import type { Tenant } from '@wedding-planner/shared'

import { ProductError } from '../product_error'
import type { TenantStore } from './tenant_store'

/**
 * @canonical tenant_context -- the unforgeable trust-boundary token for tenant isolation.
 *
 * A TenantContext is the *resolved, validated* identity of one tenant. It is the ONLY thing the
 * tenant-scoped repository accepts, and the partition key is read off it (never off a payload). The
 * load-bearing property — "the resolver is the sole mint" — is enforced by CONSTRUCTION, not by
 * convention, via two mechanisms a hand-built object cannot satisfy:
 *
 *   1. A compile-time phantom brand (a `declare`d `unique symbol` member that exists ONLY in the type
 *      system — never a runtime property). Its key is unnameable outside this module, so a structural
 *      `{ tenant_id }` literal is NOT assignable to TenantContext.
 *   2. A runtime IDENTITY token: a module-private `WeakSet` the resolver adds each minted context to;
 *      `assertMintedContext` checks membership. Membership is by object identity and is NOT a
 *      reflectable own property — there is nothing to lift with `Object.getOwnPropertySymbols` and
 *      copy onto a forged object. (An earlier draft used a real `unique symbol` own property valued
 *      `true`; doddy showed that brand was forgeable — any holder of a legitimate context could read
 *      the symbol off it and re-stamp a forged object for another tenant. The WeakSet closes that:
 *      the witness lives outside the object, so it cannot be copied.) The repository calls this guard
 *      on every operation — compile-time alone is insufficient, since the real caller (Phase 13
 *      request code, a test with `as any`) operates in plain JS where a cast bypasses the type
 *      (PRODUCT.FORGED_CONTEXT).
 *
 * The minted context is `Object.freeze`d so its tenant_id cannot be mutated after the fact
 * (`readonly` is a compile-time fiction). The resolver is slug-keyed (`resolveBySlug`): a slug is the
 * untrusted routing primitive a future request router carries, so the boundary survives contact with
 * the HTTP layer in Phase 13. Usability (lifecycle) is re-checked here at mint AND, separately, at
 * every repository operation (liveness asserted at use, fail closed) — a context is a short-lived,
 * single-request snapshot carrying NO cached lifecycle authority.
 *
 * related: tenant_scoped_repository.ts (assertMintedContext at every entry), tenant_store.ts (mint source).
 */

/**
 * Compile-time phantom brand. `declare const` means it exists ONLY in the type system — there is no
 * runtime symbol, so nothing is reflectable on a minted context. Its key is unnameable outside this
 * module, giving TenantContext nominal typing (a `{ tenant_id }` literal is not assignable).
 */
declare const TENANT_CONTEXT_BRAND: unique symbol

/** The resolved, validated identity of one tenant — the unit and subject of isolation. */
export interface TenantContext {
  readonly tenant_id: string
  readonly slug: string
  /** Phantom brand for nominal typing — never an actual runtime property (see TENANT_CONTEXT_BRAND). */
  readonly [TENANT_CONTEXT_BRAND]: true
}

/**
 * The runtime identity token. A context is "minted" iff it is a member of this set. Membership is by
 * object identity and lives OUTSIDE the object, so it cannot be reflected off a real context and
 * copied onto a forged one (the re-stamp attack the symbol-property brand was vulnerable to).
 */
const MINTED_CONTEXTS = new WeakSet<TenantContext>()

/**
 * The single source of truth for which lifecycle states may transact. The resolver and the
 * repository's liveness check both derive "usable" from this one constant (architect P2-C), so there
 * is no second, drifting definition of "active enough to use".
 */
export const USABLE_LIFECYCLE_STATUSES: readonly Tenant['lifecycle_status'][] = ['active']

/** Whether a tenant in this lifecycle state may mint a context / transact. */
export function isUsableLifecycle(status: Tenant['lifecycle_status']): boolean {
  return USABLE_LIFECYCLE_STATUSES.includes(status)
}

/**
 * Assert that `context` was minted by the resolver (carries the private brand). A hand-built or cast
 * object lacks the unnameable brand key and is rejected. Called at the top of every repository
 * operation — the runtime half of the unforgeability guarantee.
 */
export function assertMintedContext(context: TenantContext): void {
  // WeakSet.has returns false for any non-object or non-member without throwing — a forged/cast
  // object, a copied-symbol object, or a primitive all land here.
  if (!MINTED_CONTEXTS.has(context)) {
    throw new ProductError(
      'PRODUCT.FORGED_CONTEXT',
      'TenantContext was not minted by the resolver; refusing to scope an operation to it.',
      {},
    )
  }
}

/** Internal mint — the ONLY place a context joins the minted set. Freezes it against post-hoc mutation. */
function mintContext(tenant_id: string, slug: string): TenantContext {
  const context = Object.freeze({ tenant_id, slug }) as unknown as TenantContext
  MINTED_CONTEXTS.add(context)
  return context
}

/**
 * Mints {@link TenantContext}s from the untrusted routing primitive (a slug), rejecting unknown or
 * unusable tenants. This is the sole gateway from "a request names a tenant" to "an operation is
 * scoped to a tenant".
 */
export class TenantContextResolver {
  constructor(private readonly store: TenantStore) {}

  /**
   * Resolve a slug to a usable TenantContext, or throw. Unknown slug -> PRODUCT.UNKNOWN_TENANT;
   * a tenant not in a usable lifecycle state -> PRODUCT.TENANT_NOT_USABLE (fail closed).
   */
  resolveBySlug(slug: string): TenantContext {
    const tenant = this.store.findBySlug(slug)
    if (tenant === undefined) {
      throw new ProductError(
        'PRODUCT.UNKNOWN_TENANT',
        `No tenant resolves for slug '${slug}'.`,
        { context: { slug } },
      )
    }
    if (!isUsableLifecycle(tenant.lifecycle_status)) {
      throw new ProductError(
        'PRODUCT.TENANT_NOT_USABLE',
        `Tenant '${tenant.tenant_id}' is '${tenant.lifecycle_status}', not a usable state.`,
        { context: { tenant_id: tenant.tenant_id, lifecycle_status: tenant.lifecycle_status } },
      )
    }
    return mintContext(tenant.tenant_id, tenant.slug)
  }
}
