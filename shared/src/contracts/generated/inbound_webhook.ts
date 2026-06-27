/* eslint-disable */
/**
 * GENERATED from product/schemas/inbound_webhook_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The UNTRUSTED, provider-shaped payload a messaging provider's inbound webhook POSTs when a guest texts in (Phase 19) — the wire shape of messaging_port.ts `RawInboundPayload`, validated at the `/t/:slug/messaging/inbound` edge BEFORE the port normalizes it to a domain InboundMessage. Every field is opaque and NEVER authoritative: the platform NEVER bills, segments, or trusts identity from it. `from_ref`/`provider_message_ref` are opaque provider handles (no carrier concepts — no SID/E.164/segments). `channel` is the single canonical Channel (drift-guarded against shared/src/domain/channel.ts so this is not a fourth uncoordinated copy of the enum). The reply-cardinality firewall lives downstream (a platform-side per-tenant dedupe on provider_message_ref; the bill is metered from OUR send record), never here. See ADR 0019 and product/README.md.
 */
export interface InboundWebhook {
/**
 * The medium the message arrived on — the single canonical Channel. Drift-guarded EXHAUSTIVE against shared CHANNELS; a non-enum value is an honest 400 to the (trusted) provider.
 */
channel: ("email" | "sms" | "whatsapp" | "postal" | "phone")
/**
 * Opaque sender handle (the guest's provider-side address). The SOLE key the guest registry resolves a wedding binding from — never a body-smuggled guest_id/wedding_id. No carrier semantics are parsed from it.
 */
from_ref: string
/**
 * The message content. Opaque, untrusted, attacker-controlled; used ONLY to select among an already-safe answer projection, never to gate what is readable (deny-by-fact-classification).
 */
text: string
/**
 * The provider's opaque handle for this inbound message. Used for per-tenant inbound dedupe (idempotent receive) + reconciliation ONLY — never a platform identity and never the send-side idempotency key (that is platform-minted).
 */
provider_message_ref: string
}
