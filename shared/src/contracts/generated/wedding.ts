/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A couple's wedding, owned by exactly one tenant. The aggregate the planner and the couple collaborate on, and the seam where the planning engine (strategy genome / North Star) connects in a later phase. Always accessed through a tenant-scoped repository: the lookup key is (tenant_id, wedding_id), never wedding_id alone, so ids need not be globally unique. See product/README.md.
 */
export interface Wedding {
/**
 * Identity within the owning tenant's partition, injected from the id generator. Not a global key — two tenants may hold the same wedding_id without collision because the lookup key is (tenant_id, wedding_id).
 */
wedding_id: string
/**
 * The owning tenant. In the tenant-scoped repository this field is ONLY ever compared to the context's tenant_id (to veto a cross-tenant write); it is never used to select the partition (the context is). A payload tenant_id different from the context is rejected (PRODUCT.CROSS_TENANT_WRITE).
 */
tenant_id: string
/**
 * The couple's display name, e.g. 'Alex & Sam'.
 */
couple_display_name: string
/**
 * The wedding date (YYYY-MM-DD).
 */
event_date: string
/**
 * Planning lifecycle. planning = onboarding the couple; active = under active planning; completed = the wedding has happened; cancelled = called off.
 */
status: ("planning" | "active" | "completed" | "cancelled")
/**
 * ISO 8601 UTC creation time, from the injected clock (never ambient).
 */
created_at: string
/**
 * Optional. Guest-visible ceremony start time, 24-hour HH:MM. A logistics fact the guest-messaging responder may answer (rides the answered-content channel alongside event_date). NEVER a surprise/PII field — only guest-shareable logistics belong here (the deny-by-fact-classification boundary, see guest_qa_responder.ts).
 */
ceremony_time?: string
/**
 * Optional. Guest-visible venue name/location. A logistics fact answered when set, escalated when unset. Guest-shareable only — never a surprise/PII field.
 */
venue_name?: string
/**
 * Optional. Guest-visible parking guidance (free text). Answered when set, escalated when unset. maxLength caps metered-send cost + payload smuggling to guests. Guest-shareable only.
 */
parking_info?: string
/**
 * Optional. Guest-visible dress code / attire. Answered when set, escalated when unset. Guest-shareable only — never a surprise/PII field.
 */
dress_code?: string
}
