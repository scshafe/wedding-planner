/* eslint-disable */
/**
 * GENERATED from product/schemas/pending_guest_question_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A guest's question waiting for the concierge's job (issue #60, ADR 0059): written by the inbound edge, read when the job runs, deleted when it finishes. Keyed by question_id, a hash of the provider's message ref (which has no length limit). Tenant-scoped; the global job index never holds it.
 */
export interface PendingGuestQuestion {
question_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
/**
 * The wedding the guest was bound to when the message came in.
 */
wedding_id: string
/**
 * The provider's opaque handle, as received (dedupe and reconciliation only).
 */
provider_message_ref: string
/**
 * The guest's opaque sender handle (the registry binding's key).
 */
sender_ref: string
channel: ("email" | "sms" | "whatsapp" | "postal" | "phone")
/**
 * The message, untrusted. Escalated as-is; the model sees a shortened copy as data.
 */
body: string
received_at: string
}
