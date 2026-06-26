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

/** What a caller supplies to record an event. event_id + occurred_at are owned by the ledger. */
export interface RecordBillingEventInput {
  readonly tenant_id: string
  readonly kind: BillingEventKind
  /** Required iff kind is financial (`charge`/`payment`); must be absent otherwise. Integer cents. */
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
}
