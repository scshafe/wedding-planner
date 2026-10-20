/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_guest_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A person on a wedding's guest list (issue #27), in exactly one household of that wedding. Distinct from the `guest` contract (the messaging binding of an opaque sender ref). Owned by one tenant and one wedding; always reached through a tenant-scoped repository keyed (tenant_id, guest_id) and filtered by wedding_id. Contact details are personal data: never logged, shown only to the wedding's planner and couple.
 */
export interface WeddingGuest {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
guest_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
/**
 * The wedding (equal to the household's).
 */
wedding_id: string
/**
 * The household of the same wedding the guest belongs to.
 */
household_id: string
first_name: string
/**
 * May be empty (a plus-one whose name is not known yet is 'Guest of …' by first name).
 */
last_name: string
/**
 * Whose guest: the first partner's, the second's, or both.
 */
side: ("partner_one" | "partner_two" | "both")
/**
 * Free labels the planner and couple use (e.g. 'family', 'college'). At most 20 (enforced by the guest-list service: a maxItems here would generate a tuple type).
 */
tags: string[]
/**
 * Whether this guest may bring a plus-one. Always false for a plus-one.
 */
plus_one_allowed: boolean
/**
 * Present iff this guest IS a plus-one: the guest_id of the guest who brings them (same wedding and household).
 */
plus_one_of?: string
/**
 * Optional dietary needs (free text).
 */
dietary?: string
/**
 * Optional contact email. Personal data.
 */
email?: string
/**
 * Optional contact phone. Personal data.
 */
phone?: string
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last edit, when edited.
 */
updated_at?: string
}
