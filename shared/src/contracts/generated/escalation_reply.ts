/* eslint-disable */
/**
 * GENERATED from product/schemas/escalation_reply_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One message in a guest escalation's reply THREAD — multi-turn (Phase 34) and BI-DIRECTIONAL (Phase 35). Where Phase 28 sent exactly one reply per escalation and auto-resolved it, an OPEN escalation now carries MANY turns: an operator (`sender` planner/couple) `send reply` appends one of these AND dispatches a metered message back to the guest WITHOUT resolving (resolving/dismissing stays the explicit Phase-27 action); and (Phase 35) an inbound GUEST follow-up that the platform can't answer lands in the guest's most-recent OPEN escalation as a `sender:'guest'` turn instead of opening a new escalation (a RECEIVED message — no send, no charge). The thread is the question->answer transcript the inbox renders. Always accessed through a tenant-scoped repository KEYED BY (tenant_id, `${escalation_id}:${seq}`); the composite key is per-tenant. The two turn provenances have DIFFERENT idempotency keys: an operator turn dedups by the client-carried `seq` (form double-submit, read-first-put-if-absent; a same-seq/different-body re-POST is a 409 lost-update at the handler), while a guest turn dedups by `provider_message_ref` (provider re-delivery) and allocates its slot above the thread's high-water mark (`max(seq)+1`). The reply path is decoupled from the resolution: no turn writes an escalation_resolution. See escalation_reply_log.ts, escalation_log.ts, escalation_resolution_schema.json, and ADR 0034 / ADR 0035.
 */
export type EscalationReply = ({
[k: string]: unknown
} & {
/**
 * The platform-minted public surrogate id for this reply (ids.next('reply')). NEVER the storage key — the (tenant_id, `${escalation_id}:${seq}`) pair is; this is the audit/display id.
 */
reply_id: string
/**
 * The owning tenant. In the tenant-scoped repository this field is ONLY ever compared to the context's tenant_id (to veto a cross-tenant write); it never selects the partition (the context does).
 */
tenant_id: string
/**
 * The escalation this reply belongs to (guest_escalation.escalation_id) — the thread filter key; the couple/planner read joins replies by it. ALWAYS copied from the live escalation read in the same request, never a request-body field.
 */
escalation_id: string
/**
 * The wedding the escalation belongs to — the couple-scope filter key (a couple reads only the replies whose wedding_id matches their bound wedding). ALWAYS copied from the live escalation read in the same request, NEVER a request-body field, so a body-smuggled wedding_id cannot widen a couple's reach.
 */
wedding_id: string
/**
 * The reply's position in the thread (0-based) = the per-tenant double-submit/idempotency key (the composite storage key is `${escalation_id}:${seq}`) AND the numeric display order. This is the ONE field whose value originates in the request body — it is a CLIENT/EXTERNAL-CONTROLLED KEY, safe for the SAME reason escalation_log's provider_message_ref is safe as a key: the repository partition is `context.tenant_id` ALONE, so a forged seq is inert-or-self-harm within the caller's own tenant and never reaches another tenant or another escalation. The form carries `seq = (current thread length)`; a re-submit of the same form re-sends the same seq (read-first-put-if-absent dedups it to ONE send); a same-seq submit with a DIFFERENT body is a lost-update conflict (409, retry from a fresh form), never a silent drop. A forged far-future seq only leaves a harmless display gap (sort is numeric; the next legit reply takes `thread.length`).
 */
seq: number
/**
 * Who authored this turn: a `planner`/`couple` operator (principal.role, from the minted session — never the body) sending a reply, or (Phase 35) the `guest` whose inbound follow-up landed in the thread (set server-side at the inbound edge, never from a body field). Display metadata, never read for a decision; the `guest` value also pairs with a required `provider_message_ref` via the allOf above.
 */
sender: ("planner" | "couple" | "guest")
/**
 * The turn's text. For an operator turn: TRUSTED couple/planner reply text, capped at the handler's REPLY_BODY_MAX_LENGTH (a SEND/cost bound, not a storage bound — enforced ONLY at the handler, the sole surviving cap post-Phase-35). For a guest turn (Phase 35): UNTRUSTED inbound guest text, byte-identical in constraint to inbound_webhook.text / guest_escalation.text (minLength:1, NO maxLength) so any message that passed the inbound edge can never fail validation here (no 500 oracle / no swallowed capture). Both provenances are returned in the scoped `GET /t/:slug/escalations` JSON body AND HTML-escaped when rendered on the thread — a guest turn is NEVER reflected back to the guest; an operator turn's persisted copy is the transcript, read only by the same scope that wrote it. The maxLength was DROPPED in Phase 35 because the field now hosts unbounded guest input; the operator cap moved entirely to the handler.
 */
body: string
/**
 * Present IFF `sender` is `guest` (Phase 35): the opaque provider ref of the inbound guest message this turn records — its per-tenant re-delivery dedup key (recordGuestReply scans the thread for a matching ref so a re-delivered inbound records exactly one turn). A provider-controlled value safe as a dedup scan key because the partition is `context.tenant_id` ALONE and the scan is within the already-selected escalation's own thread. FORBIDDEN on operator turns (the allOf above), so its presence is the trusted guest/operator discriminant.
 */
provider_message_ref?: string
/**
 * ISO 8601 UTC time the turn was recorded, from the injected clock (never ambient; platform-stamped, not operator- or guest-controlled). minLength:1 with NO format/pattern (matches escalation_resolution.resolved_at / guest_escalation.received_at) so the real clock.now() value can never fail validation here (no 500 oracle).
 */
sent_at: string
})
