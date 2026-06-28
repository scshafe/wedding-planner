import { type BillingEvent, type Clock, getSchemaRegistry, type IdGenerator } from '@wedding-planner/shared'

import { ProductError } from '../product_error'

/**
 * @canonical billing_ledger -- the append-only, per-tenant simulated billing ledger.
 *
 * The source of truth for a tenant's billing history (the operator's `/admin/.../billing` view) and the
 * substrate the lifecycle is driven over. There is NO separate "billing account" aggregate: a tenant's
 * `plan_tier` already lives on the Tenant, and the account BALANCE is a fold over these events
 * (`balanceCents` below). Events are immutable once recorded (append-only); the backing map is
 * `#`-private, so it does not enumerate and a ledger never leaks via `JSON.stringify` / spread.
 *
 * Money is INTEGER CENTS, never a float. Financial kinds (`charge`, `usage_charge`, `payment`) carry
 * `amount_cents`; marker kinds (`provisioned`, `suspended`, `reactivated`) carry none — the contract enforces
 * this per-kind, and `record` constructs the event to match, so the fold can never sum a non-financial marker.
 * `event_id`/`occurred_at` are injected (no ambient id/time). `eventsFor` filters STRICTLY by tenant_id
 * (an operator querying tenant A never sees tenant B's events — doddy P2-1).
 *
 * related: price_book.ts (sizes the charge), onboarding_service.ts (the sole recorder, on a legal transition).
 */

/** The billing event kinds (the contract's closed enum). */
export type BillingEventKind = BillingEvent['kind']

/**
 * The kinds that carry money (and therefore participate in the balance fold). MUST stay in lockstep with the
 * `balanceCents` fold below (which hard-codes the debit/credit direction per kind) AND the schema's per-kind
 * `allOf` — adding a financial kind to one but not all three is a silent money bug. Pinned by the round-trip
 * test in billing_ledger.test.ts.
 */
const FINANCIAL_KINDS: ReadonlySet<BillingEventKind> = new Set<BillingEventKind>([
  'charge',
  'usage_charge',
  'payment',
])

/**
 * The aggregate view of one tenant's ledger (Phase 30 — the planner-facing billing summary). A per-kind fold of
 * the tenant's events: how many metered messages were sent and what they cost, the subscription fees charged, the
 * payments settled, and the resulting owed `balance_cents`. Markers (provisioned/suspended/reactivated) contribute
 * nothing. This is what the planner sees about THEIR OWN account; the price-book join (plan_tier → monthly price)
 * is layered on top in billing_summary.ts, never here (the ledger knows events, not pricing).
 */
export interface LedgerSummary {
  /** Count of `usage_charge` events — i.e. metered messages billed to this tenant. */
  readonly messages_sent: number
  /** Σ of `usage_charge` amounts — the metered-messaging spend (exactly what was billed, never a re-priced figure). */
  readonly messaging_spend_cents: number
  /** Σ of `charge` amounts — the plan/subscription fees accrued. */
  readonly subscription_charges_cents: number
  /** Σ of `payment` amounts — money settled in. */
  readonly payments_cents: number
  /** The owed balance (positive = owed), IDENTICAL to {@link BillingLedger.balanceCents}. */
  readonly balance_cents: number
}

/** What a caller supplies to record an event. event_id + occurred_at are owned by the ledger. */
export interface RecordBillingEventInput {
  readonly tenant_id: string
  readonly kind: BillingEventKind
  /** Required iff kind is financial (`charge`/`usage_charge`/`payment`); must be absent otherwise. Integer cents. */
  readonly amount_cents?: number
}

export class BillingLedger {
  /** tenant_id -> its append-only events. `#`-private: never enumerates, never serializes. */
  readonly #byTenant = new Map<string, BillingEvent[]>()

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Append a billing event for a tenant. Constructs the event so the per-kind money rule holds
   * (amount_cents present iff financial), validates against the billing_event contract, then appends.
   * A financial kind without an amount, or a marker kind with one, is rejected (PRODUCT.BAD_REQUEST)
   * before the contract check, so a malformed call never lands.
   */
  record(input: RecordBillingEventInput): BillingEvent {
    const financial = FINANCIAL_KINDS.has(input.kind)
    if (financial && input.amount_cents === undefined) {
      throw new ProductError('PRODUCT.BAD_REQUEST', `Billing kind '${input.kind}' requires amount_cents.`, {
        context: { kind: input.kind },
      })
    }
    if (!financial && input.amount_cents !== undefined) {
      throw new ProductError('PRODUCT.BAD_REQUEST', `Billing kind '${input.kind}' must not carry amount_cents.`, {
        context: { kind: input.kind },
      })
    }
    const event: BillingEvent = {
      event_id: this.ids.next('billing'),
      tenant_id: input.tenant_id,
      kind: input.kind,
      // Attach amount_cents ONLY for a financial kind, so a marker event carries no money key at all.
      ...(financial ? { amount_cents: input.amount_cents } : {}),
      occurred_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<BillingEvent>('billing_event', event)
    const existing = this.#byTenant.get(input.tenant_id)
    if (existing === undefined) {
      this.#byTenant.set(input.tenant_id, [event])
    } else {
      existing.push(event)
    }
    return event
  }

  /** A tenant's events in record order (a defensive copy; empty for a tenant with no events). */
  eventsFor(tenant_id: string): readonly BillingEvent[] {
    const events = this.#byTenant.get(tenant_id)
    return events === undefined ? [] : [...events]
  }

  /**
   * The tenant's account balance in integer cents: Σ(charge + usage_charge) − Σ(payment) over the FINANCIAL
   * events only. **Positive = money OWED** (a debit balance); zero = settled. Marker events never contribute.
   * `usage_charge` is a debit like `charge` (it accrues owed metered-messaging fees) but, unlike the monthly
   * `charge`, is not auto-paired with a settling `payment` — so accrued usage shows as an owed balance.
   */
  balanceCents(tenant_id: string): number {
    const events = this.#byTenant.get(tenant_id)
    if (events === undefined) return 0
    let balance = 0
    for (const event of events) {
      if (event.kind === 'charge' || event.kind === 'usage_charge') balance += event.amount_cents ?? 0
      else if (event.kind === 'payment') balance -= event.amount_cents ?? 0
    }
    return balance
  }

  /**
   * The per-kind aggregate of a tenant's own ledger (Phase 30 — the planner billing summary). One pass over the
   * tenant's events, bucketed by the SAME per-kind money rule as {@link balanceCents} (the debit/credit direction
   * here MUST stay in lockstep with that fold and the schema's per-kind `allOf` — they are one money model, not
   * three). `balance_cents` is DERIVED from the same buckets (`subscription + messaging_spend − payments`); a test
   * pins it equal to the canonical `balanceCents`, so the breakdown can never silently disagree with the owed
   * balance. An unknown tenant (no events) folds to all zeros. Tenant-scoped by `tenant_id` alone (the partition),
   * exactly like `eventsFor`/`balanceCents` — never reaches another tenant's events.
   */
  summarize(tenant_id: string): LedgerSummary {
    const events = this.#byTenant.get(tenant_id) ?? []
    let messages_sent = 0
    let messaging_spend_cents = 0
    let subscription_charges_cents = 0
    let payments_cents = 0
    for (const event of events) {
      if (event.kind === 'usage_charge') {
        messages_sent += 1
        messaging_spend_cents += event.amount_cents ?? 0
      } else if (event.kind === 'charge') {
        subscription_charges_cents += event.amount_cents ?? 0
      } else if (event.kind === 'payment') {
        payments_cents += event.amount_cents ?? 0
      }
    }
    return {
      messages_sent,
      messaging_spend_cents,
      subscription_charges_cents,
      payments_cents,
      balance_cents: subscription_charges_cents + messaging_spend_cents - payments_cents,
    }
  }

  /**
   * Settle the tenant's owed balance (Phase 31 — the planner-facing "pay my balance" mutation): if the tenant
   * owes money, record a SINGLE `payment` for EXACTLY the owed amount and report the settlement; otherwise record
   * nothing. The amount is sourced from the tenant's OWN trusted fold ({@link balanceCents}) — there is NO caller-
   * supplied amount, so the settled sum can never be smuggled, over-paid, or driven negative (a planner cannot
   * mint a credit balance). `payment` is the existing credit kind (in lockstep with `FINANCIAL_KINDS` /
   * `balanceCents` / the schema's per-kind `allOf` — this just records one, it changes neither the fold nor the
   * contract), so the recorded amount is a strictly-positive integer and `record`'s assertValid always passes.
   *
   * ATOMICITY: the `balanceCents` read and the `record` append are ONE synchronous critical section (no
   * `await`/yield between them). The `balance > 0` floor is the ONLY double-submit guard — a repeat call sees a
   * zero balance and is a no-op (no second payment) — and that guard depends on this section staying synchronous;
   * a future async split would re-open a double-pay, so keep it synchronous. (The offline sim is single-threaded.)
   * Tenant-scoped by `tenant_id` alone (the partition), exactly like `balanceCents`/`summarize`.
   */
  settleBalance(tenant_id: string): { paid: boolean; amount_cents: number; balance_cents: number } {
    const balance = this.balanceCents(tenant_id)
    if (balance <= 0) return { paid: false, amount_cents: 0, balance_cents: balance }
    this.record({ tenant_id, kind: 'payment', amount_cents: balance })
    return { paid: true, amount_cents: balance, balance_cents: 0 }
  }
}
