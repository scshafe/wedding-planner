import type { Tenant } from '@wedding-planner/shared'

import { ProductError } from '../product_error'

/**
 * @canonical price_book -- the simulated plan_tier -> monthly price (integer cents, no real money).
 *
 * A pure, total mapping from a tenant's `plan_tier` to its modeled monthly fee. Prices are FICTIONAL
 * (offline-first; no billing integration, no real charges) and expressed as INTEGER CENTS — money is
 * never a float anywhere in this domain. The OnboardingService consults this to size the `charge` event
 * it records on activate/reactivate. The map is exhaustive over the `plan_tier` enum, so a well-typed
 * call cannot miss; the runtime guard defends only against a stale `as PlanTier` cast at an edge (a bad
 * tier is rejected upstream by the tenant schema before it ever reaches here — see onboarding_service).
 *
 * related: billing_ledger.ts (records the priced events), onboarding_service.ts (the caller).
 */

/** The billing plan tiers (the tenant contract's closed enum). */
export type PlanTier = Tenant['plan_tier']

/** The modeled monthly price per tier, in integer cents. Fictional — no real money. */
export const MONTHLY_PRICE_CENTS: Readonly<Record<PlanTier, number>> = {
  solo: 2900,
  studio: 9900,
  agency: 29900,
}

/**
 * The modeled monthly fee for a plan tier, in integer cents. Total over `PlanTier`; throws
 * PRODUCT.BAD_REQUEST only if handed a value outside the enum (a defensive guard against a stale cast —
 * the tenant schema validates `plan_tier` before any tenant is created, so this never fires on a real path).
 */
export function monthlyPriceCents(plan_tier: PlanTier): number {
  const price = MONTHLY_PRICE_CENTS[plan_tier]
  if (price === undefined) {
    throw new ProductError('PRODUCT.BAD_REQUEST', `Unknown plan_tier '${String(plan_tier)}'.`, {
      context: { plan_tier: String(plan_tier) },
    })
  }
  return price
}
