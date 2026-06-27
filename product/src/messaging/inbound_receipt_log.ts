import { type IdGenerator } from '@wedding-planner/shared'

import { type TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical inbound_receipt_log -- the per-tenant idempotent-receive gate for inbound provider messages.
 *
 * THE REPLY-CARDINALITY FIREWALL (doddy P0). A provider's `provider_message_ref` is an UNTRUSTED, provider-
 * controlled field. If the reply send keyed its idempotency on that field directly, a provider could
 * double-charge a tenant (replay the same logical message with a FRESH ref) or suppress a reply (reuse a ref).
 * This log closes the re-delivery half: it records each `provider_message_ref` ONCE PER TENANT and mints a
 * PLATFORM-CONTROLLED receipt id for it. The inbound edge processes (and replies to) only a FRESH ref; a
 * re-delivered ref is an idempotent receive — no second reply, no second charge — and the minted receipt id
 * (never the raw provider ref) is what the reply send uses as its idempotency key. (A provider sending a
 * genuinely fresh ref for the same logical message is an genuinely distinct message — the provider's trust
 * level — and is out of scope; this gate defends against RE-delivery, not provider dishonesty.)
 *
 * Isolation is INHERITED from {@link TenantScopedRepository}: minted-context brand + liveness, the partition
 * keyed by `context.tenant_id` ALONE, the dedupe key the `provider_message_ref` ALONE, `#`-private (so two
 * tenants reusing a ref get independent receipts and neither sees the other's — no cross-tenant receipt
 * oracle, the same property the outbound meter's per-tenant idempotency index already has).
 *
 * related: messaging_service.ts (the outbound per-tenant send dedupe this complements), product_api.ts (the
 * inbound edge that calls recordInbound before triggering a reply), guest_registry.ts (the sibling gate).
 */

/** A recorded inbound receipt: the provider's ref (the dedupe key) + the platform-minted receipt id. */
interface InboundReceipt {
  readonly tenant_id: string
  readonly provider_message_ref: string
  /** Platform-minted (injected IdGenerator) — the idempotency key the reply send uses; never the provider ref. */
  readonly receipt_id: string
}

/** The result of recording an inbound: the platform receipt id + whether this was the FIRST sight of the ref. */
export interface InboundReceiptResult {
  readonly receipt_id: string
  /** True iff this `provider_message_ref` had not been seen for this tenant — i.e. a reply should be triggered. */
  readonly fresh: boolean
}

export class InboundReceiptLog {
  /** (tenant_id, provider_message_ref) -> receipt. `#`-private: never enumerates, never serializes. */
  readonly #repo: TenantScopedRepository<InboundReceipt>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly ids: IdGenerator,
  ) {
    this.#repo = new TenantScopedRepository<InboundReceipt>(liveness, (receipt) => receipt.provider_message_ref)
  }

  /**
   * Idempotent receive. Returns the EXISTING receipt id (`fresh: false`) for a re-delivered ref, or mints +
   * stores a new platform receipt id (`fresh: true`) on first sight. Scoped to the context's tenant.
   */
  recordInbound(context: TenantContext, provider_message_ref: string): InboundReceiptResult {
    const existing = this.#repo.read(context, provider_message_ref)
    if (existing !== undefined) return { receipt_id: existing.receipt_id, fresh: false }
    const receipt_id = this.ids.next('inbound')
    this.#repo.put(context, { tenant_id: context.tenant_id, provider_message_ref, receipt_id })
    return { receipt_id, fresh: true }
  }
}
