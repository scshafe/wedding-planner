/* eslint-disable */
/**
 * GENERATED from product/schemas/escalation_resolution_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * ONE transition event in a guest escalation's status HISTORY (Phase 36 — was a single terminal handled-marker in Phases 27-35). The matching `guest_escalation` is NEVER mutated (ADR 0026 F6 — it stays the immutable historical fact that the question WAS unanswerable at the time); status handling is recorded here as an APPEND-ONLY sequence of transitions instead. Always accessed through a tenant-scoped repository KEYED BY (tenant_id, `${escalation_id}:${seq}`) — one escalation holds MANY transition rows, one per server-allocated `seq`. The escalation's EFFECTIVE status is the status of its HIGHEST-`seq` transition: no rows OR a `reopened` max-`seq` ⇒ OPEN (in the inbox); a `resolved`/`dismissed` max-`seq` ⇒ HANDLED (out of the Open inbox). `resolved`/`dismissed` are recorded only from an OPEN state (so the first handling of an open escalation sticks — the old first-writer-wins, preserved); `reopened` is recorded only from a HANDLED state (an explicit operator action that returns the escalation to OPEN and re-enables billed replies). NOT terminal: an escalation can cycle resolved→reopened→resolved. The scope mirrors the escalation: a planner records over the whole tenant, a couple only over their bound wedding (`wedding_id`, COPIED from the live escalation in the same request on EVERY transition — never the request body, so a body-smuggled wedding_id cannot widen a couple's reach and every transition row carries the couple-scope filter key). Phase 34 note: a transition is PURELY a status marker — the reply transcript lives on the per-escalation reply THREAD (escalation_reply), so a console reply no longer auto-resolves and a transition carries no reply text. See escalation_resolution_log.ts, escalation_log.ts, escalation_reply_schema.json, and ADR 0027 / ADR 0034 / ADR 0036.
 */
export interface EscalationResolution {
/**
 * The platform-minted public surrogate id for this transition row (ids.next('resolution')). NEVER the storage key — the (tenant_id, `${escalation_id}:${seq}`) pair is; this is the audit/display id.
 */
resolution_id: string
/**
 * The owning tenant. In the tenant-scoped repository this field is ONLY ever compared to the context's tenant_id (to veto a cross-tenant write); it never selects the partition (the context does).
 */
tenant_id: string
/**
 * The escalation this transition belongs to (guest_escalation.escalation_id) — the thread filter key (the couple/planner read folds transitions by it to the effective status). Looked up against the live escalation log in the same request to derive `wedding_id` and enforce the couple's scope.
 */
escalation_id: string
/**
 * The wedding the escalation belongs to — the couple-scope filter key (a couple reads only the transitions whose wedding_id matches their bound wedding). ALWAYS copied from the live escalation read in the same request on EVERY transition (incl. reopen), NEVER a request-body field.
 */
wedding_id: string
/**
 * This transition's position in the escalation's status history (0-based) = part of the composite storage key `${escalation_id}:${seq}`. SERVER-ALLOCATED as `max(existing seq)+1` (0 if none) within a synchronous read-then-append critical section — NEVER a request-body field (unlike escalation_reply.seq, which is the client-carried form position), so it is not even an inert client key. The effective status is read from the MAX-`seq` row, so this also orders the history.
 */
seq: number
/**
 * The transition's target state. `resolved` = dealt with (typically the missing fact was filled); `dismissed` = not actionable (spam/irrelevant/duplicate); `reopened` (Phase 36) = returning a previously handled escalation to the Open inbox — either an explicit operator action (`resolved_by` planner/couple) or (Phase 37) an inbound guest follow-up auto-reopening a previously RESOLVED escalation (`resolved_by:'guest'`; a dismissed escalation is NEVER auto-reopened — operator dismissal is final to the guest). `resolved`/`dismissed` are recorded only from an effective-OPEN state (first handling sticks); `reopened` only from an effective-HANDLED state. The escalation's effective status = the status of its highest-`seq` transition (`reopened` ⇒ OPEN).
 */
status: ("resolved" | "dismissed" | "reopened")
/**
 * Who made THIS transition. `planner`/`couple` = the minted principal's role (from the session — never the body), the operator who resolved/dismissed/reopened. `guest` (Phase 37) = an INBOUND guest follow-up that AUTO-REOPENED a previously resolved escalation (the guest is untrusted, not a Principal; this is the honest provenance of the follow-up that triggered the reopen). `guest` appears ONLY on a `reopened` row — the inbound auto-reopen is the sole writer of a `guest`-attributed transition, and it never records `resolved`/`dismissed` (those are operator-only), so a `guest`-attributed resolve/dismiss is structurally never produced. Audit metadata; never read for a decision.
 */
resolved_by: ("planner" | "couple" | "guest")
/**
 * ISO 8601 UTC time THIS transition was recorded, from the injected clock (never ambient; platform-stamped, not guest-controlled). minLength:1 with NO format/pattern (matches guest_escalation.received_at) so the real clock.now() value can never fail validation here (no 500 oracle).
 */
resolved_at: string
}
