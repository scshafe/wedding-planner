import { getSchemaRegistry, type Clock, type EscalationReply, type IdGenerator } from '@wedding-planner/shared'

import { type TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical escalation_reply_log -- the per-tenant, wedding-scoped record of the operator (planner/couple)
 * messages sent on a guest escalation — the multi-turn reply THREAD (Phase 34). Where Phase 28 sent exactly
 * one reply per escalation and AUTO-resolved it, an OPEN escalation can now carry MANY replies: each console
 * "send reply" appends one of these and dispatches a metered guest message, WITHOUT resolving (resolving /
 * dismissing stays the explicit Phase-27 action — see {@link EscalationResolutionLog}). The thread is the
 * question→answer transcript the inbox renders; it REPLACED the Phase-29 `reply_text` that used to live on the
 * resolution.
 *
 * THE COMPOSITE KEY IS THE DOUBLE-SUBMIT GUARD. The backing {@link TenantScopedRepository} is KEYED BY
 * `${escalation_id}:${seq}` — one escalation holds many replies, one per `seq` (the 0-based thread position the
 * render carries in the reply form). {@link append} is READ-FIRST-PUT-IF-ABSENT on that key, so a re-submit of
 * the same rendered form (same escalation_id + same seq) returns the EXISTING reply and the handler sends
 * nothing twice. `seq` is the ONE field whose value originates in the request body — a CLIENT/EXTERNAL-
 * CONTROLLED KEY, safe for exactly the reason escalation_log.ts's `provider_message_ref` is safe as a key: the
 * partition is `context.tenant_id` ALONE, so a forged seq is inert-or-self-harm within the caller's own tenant
 * (it can collide only with the caller's OWN tenant's slot — never another tenant's or another escalation's),
 * and every NEW slot costs the operator a real metered send. {@link readSlot} exposes the same-key read so the
 * handler can distinguish a true double-submit (stored body === submitted) from a lost-update conflict (stored
 * body !== submitted → 409, retry from a fresh form) rather than silently dropping the second message.
 *
 * TRUSTED-STATE PROVENANCE. `tenant_id` comes from the CONTEXT (the repo vetoes a mismatch); `wedding_id` and
 * `escalation_id` are COPIED from the live escalation read in the SAME request (never a request body field — so
 * a body-smuggled id cannot widen a couple's reach); `sender` is the minted principal's role; `reply_id` /
 * `sent_at` are stamped HERE from the injected {@link IdGenerator}/{@link Clock} (never ambient/operator-
 * controlled). `body` is TRUSTED operator input, already non-empty + length-capped by the handler, read back
 * ONLY by the same scope that wrote it and HTML-escaped at render — never reflected to the guest. The record is
 * contract-validated before persisting; the handler's body cap equals the schema maxLength (drift-guarded), so a
 * reply that passed the handler can never fail validation here (no 500 oracle).
 *
 * Isolation/unforgeability are INHERITED from {@link TenantScopedRepository}: minted-context brand + liveness on
 * every op, partition keyed by `context.tenant_id` ALONE, `#`-private. The couple slice mirrors
 * escalation_resolution_log.ts: {@link listForWedding} filters the partition on `wedding_id` (oracle-free;
 * `undefined` → []), so a couple reads only their wedding's thread and never a sibling wedding's.
 *
 * related: escalation_log.ts (the escalation this replies to + the provider_message_ref-as-key precedent),
 * escalation_resolution_log.ts (the sibling handled-marker log), product_api.ts (the reply mutation + the
 * three-array read), messaging_service.ts (the metered send), ADR 0034.
 */

/** What the reply handler supplies (tenant_id from the CONTEXT; reply_id/sent_at stamped here). */
export interface RecordReplyInput {
  readonly escalation_id: string
  readonly wedding_id: string
  /** The 0-based thread position = the per-tenant double-submit key (composite `${escalation_id}:${seq}`). */
  readonly seq: number
  readonly sender: EscalationReply['sender']
  readonly body: string
}

/** The composite storage key: one escalation holds many replies, one per `seq`. */
function slotKey(escalation_id: string, seq: number): string {
  return `${escalation_id}:${seq}`
}

export class EscalationReplyLog {
  /** The isolation boundary, keyed (tenant_id, `${escalation_id}:${seq}`). `#`-private: never enumerates. */
  readonly #repo: TenantScopedRepository<EscalationReply>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {
    this.#repo = new TenantScopedRepository<EscalationReply>(liveness, (reply) => slotKey(reply.escalation_id, reply.seq))
  }

  /**
   * Read the reply occupying `(escalation_id, seq)` within the context's tenant, or `undefined` if the slot is
   * free. The handler reads this BEFORE sending: an occupied slot whose `body` equals the submitted text is a
   * true double-submit (idempotent success, no second send); an occupied slot whose `body` DIFFERS is a
   * lost-update (a stale form / a co-operator raced the slot → 409). A free slot proceeds to send + {@link
   * append}. Tenant-scoped by construction; reached only after the caller's own scope gate, so no oracle.
   */
  readSlot(context: TenantContext, escalation_id: string, seq: number): EscalationReply | undefined {
    return this.#repo.read(context, slotKey(escalation_id, seq))
  }

  /**
   * Append a reply to an escalation's thread within the context's tenant. IDEMPOTENT by `(escalation_id, seq)`
   * (read-first-put-if-absent) → a re-submit of the same slot returns the EXISTING reply (stable `reply_id` /
   * `sent_at`), so the thread never gains a duplicate row. The record's tenant_id is taken from the CONTEXT
   * (the repo vetoes a mismatch), reply_id/sent_at from the injected ids/clock; validated against the
   * `escalation_reply` contract before persisting.
   */
  append(context: TenantContext, input: RecordReplyInput): EscalationReply {
    const existing = this.#repo.read(context, slotKey(input.escalation_id, input.seq))
    if (existing !== undefined) return existing
    const reply: EscalationReply = {
      reply_id: this.ids.next('reply'),
      tenant_id: context.tenant_id,
      escalation_id: input.escalation_id,
      wedding_id: input.wedding_id,
      seq: input.seq,
      sender: input.sender,
      body: input.body,
      sent_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<EscalationReply>('escalation_reply', reply)
    return this.#repo.put(context, reply)
  }

  /** Every reply within the context's tenant (planner-facing; only ever this tenant's partition). */
  list(context: TenantContext): readonly EscalationReply[] {
    return this.#repo.list(context)
  }

  /**
   * The couple-facing slice: only the replies whose `wedding_id` matches, within the context's tenant. A
   * partition FILTER (mirrors escalation_resolution_log.ts), NOT a probe. An `undefined` wedding_id (a couple
   * with no bound wedding) yields `[]` — the collapse lives HERE so the handler stays a pure scope-`kind` branch.
   */
  listForWedding(context: TenantContext, wedding_id: string | undefined): readonly EscalationReply[] {
    if (wedding_id === undefined) return []
    return this.#repo.list(context).filter((reply) => reply.wedding_id === wedding_id)
  }
}
