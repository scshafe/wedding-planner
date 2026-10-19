import { type Channel, type IdGenerator } from '@wedding-planner/shared'

import { type BillingLedger } from '../billing/billing_ledger'
import { messagePriceCents } from '../billing/price_book'
import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import type { RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import { type TenantStore } from '../tenant/tenant_store'
import { type MessagingPort, type OutboundMessage, type SendReceipt } from './messaging_port'

/**
 * @canonical messaging_service -- the metered, margin-priced send path (the trusted-record billing boundary).
 *
 * The tenant-scoped consumer of `MessagingPort.send`. It is where the messaging firewall lives: what a tenant
 * is billed is metered from the platform's OWN record of accepted sends, NEVER from anything the (untrusted)
 * provider reports. Per accepted send it (1) dedupes idempotently PER TENANT, (2) validates the provider's
 * reported COGS as a non-negative integer, (3) prices the message from the REQUEST channel + the tenant's
 * plan_tier read from the TRUSTED `TenantStore` (never a provider/receipt field), (4) asserts a STRICTLY
 * positive margin fail-closed, (5) calls the port, and (6) transactionally records the usage in the meter +
 * a `usage_charge` in the billing ledger.
 *
 * THE FIREWALL (doddy): the provider is an untrusted external system. `costReport` bounds our price (margin)
 * and is recorded as COGS for reconciliation — it never SETS a bill. The billed amount is
 * `messagePriceCents(outbound.channel, tenant.plan_tier)` and nothing else, so a provider echoing a different
 * channel, or quoting a bogus cost, can at worst make us REFUSE to send or eat margin — it can never inflate
 * a customer's invoice. `provider_message_ref` is stored OPAQUE for reconciliation, never a platform identity
 * or dedupe key (the message_id is minted from the injected `IdGenerator`).
 *
 * ISOLATION: the meter is a per-tenant partition of the {@link RecordStore} port (like the billing ledger's; since
 * issue #8 it is durable) — the store is `#`-private, so it does not enumerate/serialize, and the idempotency key
 * is the record key WITHIN each tenant's partition, so an idempotency_key is meaningless across tenants (two
 * tenants reusing a key get independent receipts + independent charges; neither sees the other's receipt).
 * `usageView` reads exactly one partition and there is no cross-tenant aggregate accessor.
 *
 * LIFECYCLE: `send` is allowed regardless of the tenant's lifecycle_status this rung — `usage_charge` accrues
 * an owed balance either way and the fold is monotonic; gating sends / collecting accrued usage is a later
 * rung. (It DOES require the tenant to exist, since pricing reads the trusted plan_tier.)
 *
 * related: messaging_port.ts (the boundary), simulated_messaging_adapter.ts (the offline adapter),
 * price_book.ts (the tenant price + the margin invariant), billing_ledger.ts (the usage_charge sink).
 */

/** One metered send — the platform's OWN record of what it dispatched (the basis for billing). */
export interface MessageUsageRecord {
  /** Platform identity, minted from the injected IdGenerator (NEVER the provider_message_ref). */
  readonly message_id: string
  readonly channel: Channel
  readonly recipient_ref: string
  /** The provider's opaque handle — reconciliation only. */
  readonly provider_message_ref: string
  /** The provider's reported per-message COGS at send time (integer cents) — for margin reconciliation. */
  readonly provider_cost_cents: number
  /** What the tenant was billed (the `usage_charge` amount) — integer cents, priced from channel + plan_tier. */
  readonly billed_cents: number
  /** The caller's idempotency key for this logical send (scoped to this tenant). */
  readonly idempotency_key: string
  /** When the provider accepted the send (from the adapter's injected clock; ISO 8601). */
  readonly sent_at: string
}

/** The result of a `send`: the provider receipt + the metered usage, and whether it was an idempotent replay. */
export interface SendResult {
  readonly receipt: SendReceipt
  /** The usage metered for this send; for a deduped replay this is the ORIGINAL send's record. */
  readonly usage: MessageUsageRecord
  /** True iff this call matched a prior idempotency_key and neither metered nor billed again. */
  readonly deduped: boolean
}

/** A tenant's messaging usage summary — count + money totals, read from exactly one partition. */
export interface TenantUsageView {
  readonly message_count: number
  /** Σ billed_cents — equals Σ of this tenant's `usage_charge` amounts (the meter/ledger reconcile). */
  readonly billed_total_cents: number
  /** Σ provider_cost_cents — the platform's messaging COGS for this tenant. */
  readonly cogs_total_cents: number
  /** billed_total − cogs_total — the platform's gross messaging margin for this tenant (always ≥ 0). */
  readonly margin_total_cents: number
  /** A defensive copy of the tenant's metered sends, in record order. */
  readonly records: readonly MessageUsageRecord[]
}

export class MessagingService {
  /** Partition tenant_id -> idempotency_key -> the send's result. `#`-private (mirrors BillingLedger). */
  readonly #store: RecordStore

  constructor(
    private readonly port: MessagingPort,
    private readonly tenants: TenantStore,
    private readonly billing: BillingLedger,
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
  ) {
    this.#store = store
  }

  /**
   * Meter + bill one outbound message for a tenant. Idempotent per tenant: a repeat with the same
   * idempotency_key returns the original result and neither meters nor bills again. Throws (and records
   * NOTHING) on a missing/empty key, an unknown tenant, an invalid provider cost, or a non-positive margin.
   */
  send(tenant_id: string, outbound: OutboundMessage): SendResult {
    // (1) The idempotency key must be a non-empty string — never a silent shared bucket.
    const key = outbound.idempotency_key
    if (typeof key !== 'string' || key.length === 0) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'A send requires a non-empty idempotency_key.', {
        context: { tenant_id },
      })
    }

    // The check-and-record below is one synchronous critical section (single-threaded model), so a duplicate
    // key can never both pass the check and double-charge.
    // (2) Per-tenant dedupe: a hit returns the ORIGINAL receipt; the port is NOT called again, nothing is
    //     re-metered or re-billed.
    const prior = this.#store.get(COLLECTIONS.messageSend, tenant_id, key)
    if (prior !== undefined) return { ...prior, deduped: true }

    // (3) Read the TRUSTED plan_tier (pricing reads it here, never from a provider/receipt field).
    const tenant = this.tenants.findById(tenant_id)
    if (tenant === undefined) {
      throw new ProductError('PRODUCT.UNKNOWN_TENANT', `No tenant '${tenant_id}'.`, { context: { tenant_id } })
    }

    // (4) Validate the UNTRUSTED provider cost BEFORE the margin gate: a non-negative safe integer, never
    //     coalesced from missing/NaN/negative to 0.
    const providerCost = this.port.costReport(outbound.channel).cost_cents
    if (!Number.isInteger(providerCost) || providerCost < 0) {
      throw new ProductError('PRODUCT.PROVIDER_COST_INVALID', 'Provider reported an invalid per-message cost.', {
        context: { tenant_id, channel: outbound.channel, provider_cost_cents: providerCost },
      })
    }

    // (5) Price from the REQUEST channel + the trusted plan_tier — the SOLE basis for the bill.
    const billed = messagePriceCents(outbound.channel, tenant.plan_tier)

    // (6) Strict margin gate (break-even throws); a failure meters/charges nothing.
    if (!(billed > providerCost)) {
      throw new ProductError('PRODUCT.MARGIN_VIOLATION', 'Tenant message price does not exceed provider cost.', {
        context: { tenant_id, channel: outbound.channel, billed_cents: billed, provider_cost_cents: providerCost },
      })
    }

    // Past all gates → dispatch through the port.
    const receipt = this.port.send(outbound)

    // (7) Transactional on success: record the throwing write (the billing ledger contract check) FIRST, so a
    //     contract failure leaves NEITHER the meter nor the ledger touched (no partial state); then the meter
    //     record. In the composed surface both live in ONE store and the whole request is one transaction, so a
    //     storage failure after the ledger write rolls both back — keeping meter-total === Σ(usage_charge amount).
    this.billing.record({ tenant_id, kind: 'usage_charge', amount_cents: billed })
    const usage: MessageUsageRecord = {
      message_id: this.ids.next('msg'),
      channel: outbound.channel,
      recipient_ref: outbound.recipient_ref,
      provider_message_ref: receipt.provider_message_ref,
      provider_cost_cents: providerCost,
      billed_cents: billed,
      idempotency_key: key,
      sent_at: receipt.accepted_at,
    }
    const result: SendResult = { receipt, usage, deduped: false }
    this.#store.put(COLLECTIONS.messageSend, tenant_id, key, result)
    return result
  }

  /**
   * A tenant's messaging usage summary, read from exactly ONE partition. Guards existence FIRST (like
   * `OnboardingService.billingView`), so an unknown tenant_id throws PRODUCT.UNKNOWN_TENANT (→ masked 404 at
   * the edge), never a fabricated empty 200 that would be a cross-tenant existence oracle.
   */
  usageView(tenant_id: string): TenantUsageView {
    if (this.tenants.findById(tenant_id) === undefined) {
      throw new ProductError('PRODUCT.UNKNOWN_TENANT', `No tenant '${tenant_id}'.`, { context: { tenant_id } })
    }
    const records = this.#store.list(COLLECTIONS.messageSend, tenant_id).map((sent) => sent.usage)
    let billed = 0
    let cogs = 0
    for (const record of records) {
      billed += record.billed_cents
      cogs += record.provider_cost_cents
    }
    return {
      message_count: records.length,
      billed_total_cents: billed,
      cogs_total_cents: cogs,
      margin_total_cents: billed - cogs,
      records,
    }
  }
}
