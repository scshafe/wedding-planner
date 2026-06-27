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
 * This log closes the re-delivery half: it records each ref we have ALREADY SUCCESSFULLY REPLIED TO, ONCE PER
 * TENANT. The inbound edge replies only to a ref that is NOT yet `seen`; a re-delivered (already-replied) ref
 * is an idempotent receive — no second reply, no second charge. The reply send's idempotency key is a SEPARATE
 * platform-minted id ({@link mintReplyId}), never the raw provider ref.
 *
 * COMMIT-AFTER-SUCCESS (doddy P1). A ref is marked replied ONLY AFTER its reply send SUCCEEDS ({@link
 * markReplied}). So if a send ever throws (e.g. a future margin/cost failure), the ref stays un-`seen` and a
 * re-delivery can retry — a failed send is a dropped reply, never a permanently SUPPRESSED message, and the
 * synchronous webhook ack stays the uniform 202 (the edge swallows the send error). The log therefore holds
 * exactly "refs we charged a reply for", which is precisely the set the charge-dedupe must gate. (A provider
 * sending a genuinely fresh ref for the same logical message is a genuinely distinct message — the provider's
 * trust level — and is out of scope; this gate defends against RE-delivery, not provider dishonesty.)
 *
 * Isolation is INHERITED from {@link TenantScopedRepository}: minted-context brand + liveness, the partition
 * keyed by `context.tenant_id` ALONE, the dedupe key the `provider_message_ref` ALONE, `#`-private (so two
 * tenants reusing a ref get independent receipts and neither sees the other's — no cross-tenant receipt
 * oracle, the same property the outbound meter's per-tenant idempotency index already has).
 *
 * related: messaging_service.ts (the outbound per-tenant send dedupe this complements), product_api.ts (the
 * inbound edge: seen -> reply -> markReplied), guest_registry.ts (the sibling gate).
 */

/** A recorded inbound receipt: a ref the platform has successfully replied to (+ the platform reply id, audit). */
interface InboundReceipt {
  readonly tenant_id: string
  readonly provider_message_ref: string
  /** The platform-minted id used as the reply send's idempotency key (audit/reconciliation; never the provider ref). */
  readonly reply_id: string
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

  /** True iff this tenant has ALREADY SUCCESSFULLY REPLIED to `provider_message_ref` (a re-delivery → no-op). */
  seen(context: TenantContext, provider_message_ref: string): boolean {
    return this.#repo.read(context, provider_message_ref) !== undefined
  }

  /**
   * Mint a fresh PLATFORM-CONTROLLED idempotency id for a reply send (NOT persisted; never the provider ref).
   * Minted before the send so it keys the send; the ref is persisted only after the send succeeds.
   */
  mintReplyId(): string {
    return this.ids.next('inbound')
  }

  /** Record that a reply to `provider_message_ref` succeeded for this tenant (called AFTER a successful send). */
  markReplied(context: TenantContext, provider_message_ref: string, reply_id: string): void {
    this.#repo.put(context, { tenant_id: context.tenant_id, provider_message_ref, reply_id })
  }
}
