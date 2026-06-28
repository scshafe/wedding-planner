/* eslint-disable */
/**
 * GENERATED from product/schemas/escalation_resolution_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A couple/planner's record that a guest escalation has been HANDLED (Phase 27) — the SEPARATE, append-only resolution record pinned by ADR 0026 F6: the matching `guest_escalation` is NEVER mutated (it stays the immutable historical fact that the question WAS unanswerable at the time), so handling is recorded here instead. Always accessed through a tenant-scoped repository KEYED BY (tenant_id, escalation_id), read-first-put-if-absent, so resolving an already-handled escalation returns the EXISTING record (FIRST-writer-wins: the first `status` sticks, the record is immutable). `status` is terminal — both `resolved` (dealt with, typically by filling the missing fact) and `dismissed` (not actionable: spam/irrelevant/duplicate) move the escalation out of the Open inbox; re-opening / changing a recorded status is a deferred future rung. The scope mirrors the escalation: a planner records over the whole tenant, a couple only over their bound wedding (`wedding_id`, COPIED from the live escalation in the same request — never the request body, so a body-smuggled wedding_id cannot widen a couple's reach). See escalation_resolution_log.ts, escalation_log.ts, and ADR 0027.
 */
export type EscalationResolution = ({
[k: string]: unknown
} & {
/**
 * The platform-minted public surrogate id for this record (ids.next('resolution')). NEVER the storage key — the (tenant_id, escalation_id) pair is; this is the audit/display id.
 */
resolution_id: string
/**
 * The owning tenant. In the tenant-scoped repository this field is ONLY ever compared to the context's tenant_id (to veto a cross-tenant write); it never selects the partition (the context does).
 */
tenant_id: string
/**
 * The handled escalation's public id (guest_escalation.escalation_id) — the per-tenant idempotency/storage KEY (read-first-put-if-absent), so a re-resolve records exactly one resolution. Looked up against the live escalation log in the same request to derive `wedding_id` and enforce the couple's scope.
 */
escalation_id: string
/**
 * The wedding the handled escalation belongs to — the couple-scope filter key (a couple reads only the resolutions whose wedding_id matches their bound wedding). ALWAYS copied from the live escalation read in the same request, NEVER a request-body field.
 */
wedding_id: string
/**
 * The terminal handled state. `resolved` = dealt with (typically the missing fact was filled); `dismissed` = not actionable (spam/irrelevant/duplicate). Both hide the escalation from the Open inbox. Not re-openable; first-writer-wins.
 */
status: ("resolved" | "dismissed")
/**
 * The role of the principal who handled it (principal.role, from the minted session — never the body). Audit metadata; never read for a decision.
 */
resolved_by: ("planner" | "couple")
/**
 * ISO 8601 UTC time the escalation was handled, from the injected clock (never ambient; platform-stamped, not guest-controlled). minLength:1 with NO format/pattern (matches guest_escalation.received_at) so the real clock.now() value can never fail validation here (no 500 oracle).
 */
resolved_at: string
/**
 * OPTIONAL (Phase 29): the operator's answer text, present ONLY when the escalation was resolved by a console reply-from-the-inbox (absent on the resolve-form and dismiss paths — and the allOf forbids it entirely when status is `dismissed`). TRUSTED couple/planner input; returned in the scoped `GET /t/:slug/escalations` JSON body AND HTML-escaped when rendered on the Handled inbox row — never reflected back to the guest (the guest send used the operator's freshly-typed text; this persisted copy is read only by the same scope that wrote it). maxLength:2000 MATCHES the handler's REPLY_TEXT_MAX_LENGTH and minLength:1 matches requireString's non-empty guarantee, so a reply that passed the handler can never fail validation here (no 500 oracle); the two `2000`s are drift-guarded by a test.
 */
reply_text?: string
})
