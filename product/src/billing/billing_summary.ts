import type { LedgerSummary } from './billing_ledger'
import { monthlyPriceCents, type PlanTier } from './price_book'

/**
 * @canonical billing_summary -- the planner-facing billing & usage projection (Phase 30).
 *
 * The customer-facing counterpart to the operator's raw `billingView` (`{ events, balance_cents }`): where the
 * operator audits every event of any tenant, the PLANNER sees an aggregate summary of their OWN account —
 * plan + monthly price, metered-message usage (count + spend), subscription fees, payments, and the owed
 * balance. It surfaces the first-class metered-pricing concern to the person paying (the meter → bill → customer
 * loop), closing the gap left by Phase 18/20 (the platform meters and bills, but the tenant never saw it).
 *
 * A PURE PROJECTION, like strategy_guidance.ts — a render-time view, NOT a persisted record, so there is no new
 * contract (the manifest stays unchanged). It joins exactly two trusted inputs:
 *
 *  - the tenant's TRUSTED `plan_tier` (read off the minted TenantContext's tenant in the handler, never a body
 *    field), priced by {@link monthlyPriceCents} — the SAME price-book function `OnboardingService` uses to size
 *    the monthly `charge`, so the displayed monthly price can never drift from what is actually billed (one
 *    price table, not two); and
 *  - the tenant's own {@link LedgerSummary} (the per-kind fold of its ledger events).
 *
 * It exposes ONLY tenant-side figures: the tenant-facing monthly price and the amounts actually billed
 * (`messaging_spend_cents` is `Σ usage_charge`, straight from the ledger — never a re-priced figure, and never
 * the provider COGS or the platform margin, which stay internal to price_book.ts / messaging_service.ts).
 *
 * related: billing_ledger.ts (the fold this layers pricing onto), price_book.ts (the monthly price source),
 * product_api.ts (the GET /t/:slug/billing handler that builds + serves this), pages.ts (renderBilling).
 */

/** The planner-facing billing & usage summary for one tenant (render-time projection — no schema). */
export interface BillingSummary extends LedgerSummary {
  /** The tenant's plan tier (their own account fact — safe to show the tenant). */
  readonly plan_tier: PlanTier
  /** The modeled monthly fee for that tier, in integer cents — from {@link monthlyPriceCents} (the billed source). */
  readonly monthly_price_cents: number
}

/**
 * Build the planner-facing {@link BillingSummary} from a tenant's TRUSTED plan tier and its own ledger fold.
 * Pure: no I/O, no clock, no ambient state — a deterministic function of its two inputs (mirrors
 * `describeStrategy`). The monthly price is sourced from the SAME `monthlyPriceCents` used to bill it.
 */
export function buildBillingSummary(plan_tier: PlanTier, ledger: LedgerSummary): BillingSummary {
  return {
    plan_tier,
    monthly_price_cents: monthlyPriceCents(plan_tier),
    ...ledger,
  }
}
