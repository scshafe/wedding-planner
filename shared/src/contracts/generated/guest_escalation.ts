/* eslint-disable */
/**
 * GENERATED from product/schemas/guest_escalation_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A recorded guest question the platform could NOT answer (Phase 26) — the persisted product-side trace of an `escalated` responder outcome (guest_qa_responder.ts: a logistics fact was unset, or the topic was unknown). It closes the guest->couple loop: the couple (their wedding) and planner (whole tenant) read these to learn WHICH fact to fill so the next ask is answered. ONLY `escalated` is recorded — NEVER `refused`: refused is the fact-independent surprise outcome, so recording it would persist surprise-probe content and is omittable with zero wire change (both escalated and refused already produce the uniform 202). Always accessed through a tenant-scoped repository KEYED BY (tenant_id, provider_message_ref) — the same per-tenant idempotent-receive key inbound_receipt_log.ts uses — so a re-delivered inbound message records exactly one escalation (read-first-put-if-absent). `text` is UNTRUSTED guest input: stored for the trusted couple/planner, HTML-escaped at render (never reflected to the guest), and its constraint is byte-identical to inbound_webhook.text (minLength 1, NO maxLength) so a message that passed the inbound edge can never fail validation here (no 500 oracle). See guest_qa_responder.ts, escalation_log.ts, and ADR 0026.
 */
export interface GuestEscalation {
/**
 * The platform-minted public surrogate id for this record (ids.next('escalation')), stable across a re-delivery. NEVER the provider's ref — the storage/idempotency key is provider_message_ref; this is the audit/display id.
 */
escalation_id: string
/**
 * The owning tenant. In the tenant-scoped repository this field is ONLY ever compared to the context's tenant_id (to veto a cross-tenant write); it never selects the partition (the context does).
 */
tenant_id: string
/**
 * The wedding the guest is bound to (from the trusted registry binding, never a body field) — the couple-scope key: a couple reads only the escalations whose wedding_id matches their bound wedding.
 */
wedding_id: string
/**
 * The opaque sender handle of the guest who asked (the inbound from_ref). Already disclosed to the couple via the Phase-24 guest list, so no new disclosure. NO carrier semantics parsed from it.
 */
from_ref: string
/**
 * The guest's question, verbatim. UNTRUSTED, attacker-controlled: stored for the trusted couple/planner to read and HTML-escaped at render — NEVER reflected back to the guest. Constraint is byte-identical to inbound_webhook.text (minLength 1, NO maxLength) so any text that passed the inbound edge validates here (no 500/length oracle).
 */
text: string
/**
 * ISO 8601 UTC time the inbound message was received, from the injected clock (never ambient; platform-stamped, not guest-controlled).
 */
received_at: string
/**
 * The provider's opaque handle for the inbound message — the per-tenant idempotency/storage KEY (read-first-put-if-absent), so a re-delivery records exactly one escalation. Same provider_message_ref-as-dedup-key pattern as inbound_receipt_log.ts; never a platform identity.
 */
provider_message_ref: string
}
