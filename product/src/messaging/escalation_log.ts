import { getSchemaRegistry, type Channel, type GuestEscalation, type IdGenerator } from '@wedding-planner/shared'

import { type TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import type { RecipientRef } from './messaging_port'

/**
 * @canonical escalation_log -- the per-tenant, wedding-scoped record of guest questions the platform could NOT
 * answer (Phase 26). The product-side trace of an `escalated` responder outcome (guest_qa_responder.ts: a
 * logistics fact was unset, or the topic was unknown). It closes the guest->couple loop: the couple (their
 * wedding) and planner (whole tenant) READ these to learn which fact to fill so the next ask is answered.
 *
 * THE NO-ORACLE KEYSTONE: ONLY `escalated` is recorded here, NEVER `refused`. `refused` is the fact-independent
 * surprise outcome (the frozen REFUSED constant, read no wedding data). Recording it would persist surprise-probe
 * content for exactly the topic the system is designed never to engage — and it is SAFE to omit, because the
 * guest's wire is unchanged (escalated and refused both already produce the uniform 202; the record is written
 * server-side and is visible ONLY to the already-authorized couple/planner). So "a refused probe never appears in
 * my inbox" is observable to no one who could exploit it, and COMMS.SURPRISE_LEAK stays intact. The capture
 * predicate at the inbound edge is exactly `outcome.action === 'escalated'`.
 *
 * IDEMPOTENCY IS THE RECEIPT-LOG PATTERN, REUSED — NOT THE RECEIPT LOG WIDENED. The backing
 * {@link TenantScopedRepository} is KEYED BY `provider_message_ref` — the SAME per-tenant idempotent-receive key
 * inbound_receipt_log.ts uses (a provider-controlled value is fine as a key: the partition is `context.tenant_id`
 * ALONE, so two tenants reusing a ref get independent records and neither sees the other's). {@link record} is
 * READ-FIRST-PUT-IF-ABSENT, so a re-delivered inbound message records exactly one escalation with a stable
 * `escalation_id`. We do NOT mark the receipt log for an escalation (it stays the pristine doddy-P0 "refs we
 * charged a reply for" store): the two logs dedup DIFFERENT side effects (a charged reply vs a recorded
 * escalation). One pattern applied twice, not a second mechanism.
 *
 * `text` is UNTRUSTED guest input: stored for the trusted couple/planner, HTML-escaped at render (never reflected
 * to the guest). Its schema constraint is byte-identical to inbound_webhook.text (minLength 1, NO maxLength), and
 * every field {@link record} writes is sourced from values already validated upstream (from_ref/text/
 * provider_message_ref by inbound_webhook; wedding_id from the trusted binding; received_at port-stamped), so the
 * `assertValid` here can never be provoked to throw by guest input that passed the inbound edge (no 500 oracle).
 *
 * Isolation/unforgeability are INHERITED from {@link TenantScopedRepository}: minted-context brand + liveness on
 * every op, partition keyed by `context.tenant_id` ALONE, `#`-private. The couple slice mirrors
 * guest_registry.ts: {@link listForWedding} filters the partition on `wedding_id` (oracle-free; `undefined` → []).
 *
 * related: guest_qa_responder.ts (produces the `escalated` outcome), inbound_receipt_log.ts (the dedup pattern
 * reused), guest_registry.ts (the couple-scope filter mirrored), product_api.ts (the inbound capture + the read).
 */

/** What the inbound edge supplies to record an escalation (tenant_id comes from the CONTEXT, never the input). */
export interface RecordEscalationInput {
  readonly wedding_id: string
  readonly from_ref: RecipientRef
  readonly text: string
  readonly received_at: string
  readonly provider_message_ref: string
  /** The channel the guest's question arrived on — copied from the validated inbound message (Phase 28),
   * stored as the reply-routing snapshot (a console reply is sent back over THIS channel). */
  readonly channel: Channel
}

export class EscalationLog {
  /** The isolation boundary, keyed (tenant_id, provider_message_ref). `#`-private: never enumerates/serializes. */
  readonly #repo: TenantScopedRepository<GuestEscalation>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly ids: IdGenerator,
  ) {
    this.#repo = new TenantScopedRepository<GuestEscalation>(liveness, (escalation) => escalation.provider_message_ref)
  }

  /**
   * Record an `escalated` guest question within the context's tenant. IDEMPOTENT by `provider_message_ref`
   * (read-first-put-if-absent): a re-delivered inbound message returns the EXISTING record (stable
   * `escalation_id`), never a duplicate. The record's tenant_id is taken from the CONTEXT (the repo vetoes a
   * mismatch); validated against the `guest_escalation` contract before persisting (mirrors GuestRegistry.register).
   */
  record(context: TenantContext, input: RecordEscalationInput): GuestEscalation {
    const existing = this.#repo.read(context, input.provider_message_ref)
    if (existing !== undefined) return existing
    const escalation: GuestEscalation = {
      escalation_id: this.ids.next('escalation'),
      tenant_id: context.tenant_id,
      ...input,
    }
    getSchemaRegistry().assertValid<GuestEscalation>('guest_escalation', escalation)
    return this.#repo.put(context, escalation)
  }

  /**
   * Look up the escalation a given inbound `provider_message_ref` CREATED, or `undefined` (Phase 35). The
   * backing repo is keyed by `provider_message_ref`, so this is the O(1) direct read (unlike the
   * `getByEscalationId` scan). The inbound handler's process-once gate uses it to no-op a re-delivery of an
   * escalation-creating message BEFORE routing it (so a re-delivery is never threaded as a spurious guest
   * turn). Tenant-scoped by construction; a missing/foreign ref returns `undefined` (no oracle).
   */
  getByProviderRef(context: TenantContext, provider_message_ref: string): GuestEscalation | undefined {
    return this.#repo.read(context, provider_message_ref)
  }

  /** Every escalation within the context's tenant (planner-facing; only ever this tenant's partition). */
  list(context: TenantContext): readonly GuestEscalation[] {
    return this.#repo.list(context)
  }

  /**
   * Look up a single escalation by its public `escalation_id` within the context's tenant (Phase 27 — the
   * resolution path needs the escalation's `wedding_id` to enforce the couple's scope before recording a
   * resolution). The backing repo is keyed by `provider_message_ref`, so this is a partition SCAN
   * (`list().find`) — acceptable at the offline single-tenant scale; a future store swap that needs an index
   * would add a secondary map without changing this signature. It is tenant-scoped by construction: `list`
   * only ever returns the context tenant's records, so this can never reach another tenant's escalation. A
   * missing/foreign id returns `undefined` (no oracle — the caller masks absent and out-of-scope identically).
   */
  getByEscalationId(context: TenantContext, escalation_id: string): GuestEscalation | undefined {
    return this.#repo.list(context).find((escalation) => escalation.escalation_id === escalation_id)
  }

  /**
   * The couple-facing slice: only the escalations whose `wedding_id` matches, within the context's tenant. A
   * partition FILTER (the response carries ONLY matching records — nothing about other weddings), NOT a probe.
   * An `undefined` wedding_id (a couple with no bound wedding) yields `[]` — the collapse lives HERE so the
   * handler stays a pure scope-`kind` branch (mirrors guest_registry.listForWedding).
   */
  listForWedding(context: TenantContext, wedding_id: string | undefined): readonly GuestEscalation[] {
    if (wedding_id === undefined) return []
    return this.#repo.list(context).filter((escalation) => escalation.wedding_id === wedding_id)
  }
}
