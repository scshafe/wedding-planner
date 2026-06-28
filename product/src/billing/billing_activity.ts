import type { BillingEvent } from '@wedding-planner/shared'

import { type FinancialBillingEventKind, FINANCIAL_KINDS } from './billing_ledger'

/**
 * @canonical billing_activity -- the planner-facing billing ACTIVITY projection (Phase 32).
 *
 * The itemized counterpart to `billing_summary.ts`: where the summary AGGREGATES a tenant's ledger into totals
 * (usage count + spend, subscription fees, payments, owed balance), the activity list shows the individual line
 * items behind those totals — "here's what you were charged and paid, and when". It is the customer-facing
 * analogue of the operator's raw `billingView.events`, scoped to the tenant's OWN events (the handler feeds it
 * `BillingLedger.eventsFor(context.tenant_id)` — the same partition key the summary uses, never a body field).
 *
 * A PURE render-time projection, like `buildBillingSummary` / `describeStrategy` — no persisted record, so no new
 * contract (the manifest is unchanged). Two deliberate shaping decisions:
 *
 *  - FINANCIAL kinds ONLY. The list filters to `FINANCIAL_KINDS` (`charge` / `usage_charge` / `payment`) and DROPS
 *    the lifecycle markers (`provisioned` / `suspended` / `reactivated`). The aggregate summary already hides
 *    markers (its fold sums only the financial kinds), so surfacing `suspended`/`reactivated` here would be a NEW
 *    delinquency-history disclosure — operator-tier state crossing to the customer surface. Filtering to financial
 *    keeps the activity a strict DECOMPOSITION of the same numbers the summary aggregates (the reconciliation in
 *    billing_activity.test.ts is then exact and total), and reuses the SAME `FINANCIAL_KINDS` set the balance fold
 *    keys off — a future financial kind flows into the balance, the summary, AND this list together.
 *  - A tenant-SAFE shape, built by EXPLICIT pick. Each entry is constructed from named fields
 *    (`{ kind, amount_cents, occurred_at }`) — never by spreading the raw `BillingEvent` and deleting keys. The
 *    `BillingEvent` type permits `additionalProperties`, so a spread-rest could forward a future stray key (or the
 *    internal `event_id` / the redundant `tenant_id`) to the customer; the explicit pick makes "drops event_id and
 *    tenant_id" a structural guarantee, not a function of the current event shape. No provider COGS / margin / id.
 *
 * The list is NEWEST-FIRST: a copy of the trusted record (append) order, reversed — NOT a sort by `occurred_at`
 * (so a non-monotonic / equal-timestamp injected clock creates no reorder ambiguity). Order is a pure function of
 * the trusted append order, never an untrusted field.
 *
 * related: billing_summary.ts (the aggregate this itemizes), billing_ledger.ts (eventsFor + FINANCIAL_KINDS),
 * product_api.ts (the GET /t/:slug/billing handler that builds + serves this), pages.ts (renderBilling).
 */

/** One line item in the planner-facing billing activity list (render-time projection — no schema). */
export interface BillingActivityEntry {
  /** The financial event kind — always one of charge / usage_charge / payment (markers are filtered out). */
  readonly kind: FinancialBillingEventKind
  /** The amount in integer cents (every entry is financial, so this is always present). */
  readonly amount_cents: number
  /** ISO 8601 UTC time the event was recorded (from the injected clock). */
  readonly occurred_at: string
}

/** True for a financial event; narrows `kind` to {@link FinancialBillingEventKind} for the explicit pick below. */
function isFinancial(event: BillingEvent): event is BillingEvent & { kind: FinancialBillingEventKind } {
  return FINANCIAL_KINDS.has(event.kind)
}

/**
 * Build the planner-facing activity list from a tenant's own ledger events: filter to the FINANCIAL kinds, project
 * each to a tenant-safe `{ kind, amount_cents, occurred_at }` (explicit pick — drops `event_id`/`tenant_id`), and
 * return NEWEST-FIRST. Pure: a deterministic function of its input (no I/O, no clock). `amount_cents` is taken with
 * a `?? 0` guard to match the balance fold's convention — a financial event always carries it (the contract's
 * per-kind `allOf`), so the guard never fires; it is defense-in-depth, never a real zero.
 */
export function buildBillingActivity(events: readonly BillingEvent[]): BillingActivityEntry[] {
  return [...events]
    .reverse()
    .filter(isFinancial)
    .map((event) => ({ kind: event.kind, amount_cents: event.amount_cents ?? 0, occurred_at: event.occurred_at }))
}
