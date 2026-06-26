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
 *   1. A module-private `unique symbol` brand. It is never exported, so no code outside this module
 *      can name the property key — a structural `{ tenant_id }` literal is therefore NOT assignable
 *      to TenantContext (compile-time), and lacks the brand at runtime.
 *   2. A runtime `assertMintedContext` guard the repository calls on every operation. Compile-time
 *      alone is insufficient: the real caller (Phase 13 request code, a test with `as any`) operates
 *      in plain JS, where a cast bypasses the type. The runtime brand check catches it
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

/** Module-private brand. Not exported. Only `mintContext` below can stamp it. */
const TENANT_CONTEXT_BRAND: unique symbol = Symbol('product.tenant_context.brand')

/** The resolved, validated identity of one tenant — the unit and subject of isolation. */
export interface TenantContext {
  readonly tenant_id: string
  readonly slug: string
  /** Unforgeable witness: present only on a resolver-minted context (key unnameable outside this module). */
  readonly [TENANT_CONTEXT_BRAND]: true
}

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
  const branded =
    typeof context === 'object' &&
    context !== null &&
    (context as unknown as Record<symbol, unknown>)[TENANT_CONTEXT_BRAND] === true
  if (!branded) {
    throw new ProductError(
      'PRODUCT.FORGED_CONTEXT',
      'TenantContext was not minted by the resolver (missing brand); refusing to scope an operation to it.',
      {},
    )
  }
}

/** Internal mint — the ONLY place the brand is stamped. Freezes the context against post-hoc mutation. */
function mintContext(tenant_id: string, slug: string): TenantContext {
  return Object.freeze({ tenant_id, slug, [TENANT_CONTEXT_BRAND]: true as const })
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
