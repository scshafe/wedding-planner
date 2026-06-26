import type { Channel, Tenant } from '@wedding-planner/shared'

import { ProductError } from '../product_error'

/**
 * @canonical price_book -- the simulated tenant pricing (integer cents, no real money).
 *
 * A pure, total mapping from a tenant's `plan_tier` to its modeled monthly fee, and from a
 * `(channel, plan_tier)` to its modeled per-message price (Phase 18: metered messaging). Prices are
 * FICTIONAL (offline-first; no billing integration, no real charges) and expressed as INTEGER CENTS —
 * money is never a float anywhere in this domain. The OnboardingService consults the monthly map to size
 * the `charge` it records on activate/reactivate; the MessagingService consults the per-message map to size
 * the `usage_charge` it records per accepted send. Both maps are exhaustive over their enums, so a
 * well-typed call cannot miss; the runtime guards defend only against a stale `as` cast at an edge.
 *
 * MARGIN INVARIANT (load-bearing, enforced at runtime by the MessagingService, NOT here): for every
 * `(channel, plan_tier)`, `messagePriceCents` must STRICTLY exceed the provider's reported per-message COGS
 * (`MessagingPort.costReport`). This price book is the TENANT price (what the platform charges the tenant);
 * the COGS is what the provider charges the platform. We never knowingly sell messaging at a loss — the
 * service validates the provider cost as a non-negative integer and asserts the margin fail-closed BEFORE
 * metering. The price book deliberately does NOT import any adapter's COGS (price stays adapter-independent);
 * the shipped simulated adapter's COGS is held below these prices and a test pins that the happy path clears
 * the margin (see messaging tests). Tenant prices fall by tier (a volume discount), so `plan_tier` — read
 * from the TRUSTED TenantStore, never from any provider/receipt field — genuinely moves the price.
 *
 * related: billing_ledger.ts (records the priced events), onboarding_service.ts (monthly caller),
 * messaging_service.ts (per-message caller + the margin assertion), simulated_messaging_adapter.ts (COGS).
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

/**
 * The modeled TENANT price per outbound message, in integer cents, by `(channel, plan_tier)`. Higher tiers
 * pay less per message (a volume discount), so a tenant's plan tier genuinely moves the price. Every entry is
 * held strictly above the simulated provider COGS for that channel, so the margin assertion clears on the
 * happy path; the runtime check in the MessagingService is the real guard. Fictional — no real money.
 */
export const MESSAGE_PRICE_CENTS: Readonly<Record<Channel, Readonly<Record<PlanTier, number>>>> = {
  email: { solo: 3, studio: 2, agency: 2 },
  sms: { solo: 6, studio: 5, agency: 4 },
  whatsapp: { solo: 4, studio: 3, agency: 3 },
  phone: { solo: 15, studio: 13, agency: 11 },
  postal: { solo: 95, studio: 90, agency: 85 },
}

/**
 * The modeled per-message price the tenant pays for one outbound message on `channel`, in integer cents.
 * Total over `Channel` × `PlanTier`; throws PRODUCT.BAD_REQUEST only on a value outside either enum (a
 * defensive guard against a stale cast — both are schema-validated upstream). This is the SOLE basis for a
 * `usage_charge` amount; it never reads a provider/receipt field, so a provider cannot move a tenant's bill.
 */
export function messagePriceCents(channel: Channel, plan_tier: PlanTier): number {
  const byTier = MESSAGE_PRICE_CENTS[channel]
  const price = byTier?.[plan_tier]
  if (price === undefined) {
    throw new ProductError(
      'PRODUCT.BAD_REQUEST',
      `No message price for channel '${String(channel)}' / plan_tier '${String(plan_tier)}'.`,
      { context: { channel: String(channel), plan_tier: String(plan_tier) } },
    )
  }
  return price
}
