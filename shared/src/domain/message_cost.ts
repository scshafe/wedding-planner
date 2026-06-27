import { type Channel, CHANNELS } from './channel'

/**
 * @canonical message_cost -- the single INWARD per-message money cost basis (integer cents, per Channel).
 *
 * The modeled marginal money one outbound message costs, keyed by `Channel` and tier-FREE. This is the
 * cost basis the offline eval/loop reads to price the AI's comms strategy: the Phase-20 North-Star
 * `money_cost` denominator term sums `message_count × MESSAGE_COST_CENTS[channel]` so the tier-1
 * cadence/spacing/batching knobs trade REAL money, not only guest attention.
 *
 * WHY IT LIVES IN `shared` (the firewall): the eval/loop core imports ONLY `@wedding-planner/shared`, never
 * `product` (the trusted-evidence firewall, preserved by reachability — the graph stays acyclic). So the
 * inward cost basis CANNOT be imported from `product/src/billing/price_book.ts`; it lives here, and both the
 * eval simulator and (conceptually) the product reference the same `Channel` cost concept.
 *
 * VENDOR-AGNOSTIC (constraint 2 — no vendor lock-in): this is the DOMAIN's modeled per-message carrier cost,
 * NOT any one provider's reported COGS. The objective must not depend on which adapter is wired
 * (`SIMULATED_PROVIDER_COST_CENTS` in simulated_messaging_adapter.ts is one adapter's `costReport`; a real
 * adapter reports its own). These domain numbers are the cost the comms strategy TRADES, independent of the
 * carrier — so swapping providers never moves the inward objective. They sit in the same fictional ballpark
 * as the shipped simulated adapter's COGS (and are ordered like reality: a letter ≫ a call ≫ a text).
 *
 * RELATION TO THE PRODUCT PRICE BOOK (`product/src/billing/price_book.ts`): that table is the tenant-facing
 * RETAIL price (`MESSAGE_PRICE_CENTS`, per `(channel, plan_tier)`, with margin), a SEPARATE concern. This
 * carrier-cost basis is deliberately HELD STRICTLY BELOW every retail price so the product's margin invariant
 * (retail > cost) holds against the DOMAIN cost too — a cross-table consistency test in the product workspace
 * pins `MESSAGE_PRICE_CENTS[channel][tier] > MESSAGE_COST_CENTS[channel]` for every channel/tier (product may
 * import both; eval may not import product). Unifying the cost notions onto this one basis is a recorded
 * follow-up, not Phase 20 — keeping them conceptually linked but separate keeps the firewall reasoning clean.
 *
 * Fictional — no real money, offline-first. Integer cents (money is never a float in this domain).
 *
 * related: domain/channel.ts (the key enum), eval-harness money_cost wiring (the sole consumer), telemetry
 * messaging_money_total_cents metric, product/src/billing/price_book.ts (the separate retail table),
 * product/src/messaging/simulated_messaging_adapter.ts (one adapter's COGS, NOT this domain basis).
 */
export const MESSAGE_COST_CENTS: Readonly<Record<Channel, number>> = {
  email: 1,
  sms: 2,
  whatsapp: 1,
  phone: 5,
  postal: 60,
}

/**
 * The modeled marginal cost of one outbound message on `channel`, in integer cents. Total over `Channel`;
 * throws only on a value outside the enum (a defensive guard against a stale `as` cast at an edge — every
 * `channel` is schema-validated upstream, so this never fires on a real path). The throw uses a plain Error
 * (this module is dependency-free shared domain code; structured DOMAIN errors belong to the consuming
 * workspaces) — callers that have a structured-error context should validate channel membership first.
 */
export function messageCostCents(channel: Channel): number {
  const cents = MESSAGE_COST_CENTS[channel]
  if (cents === undefined) {
    throw new Error(`message_cost: unknown channel '${String(channel)}'.`)
  }
  return cents
}

/** Whether a value is a known `Channel` — for edge validation before indexing the cost table. */
export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
}
