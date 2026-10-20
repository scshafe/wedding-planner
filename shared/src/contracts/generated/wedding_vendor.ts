/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_vendor_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One vendor of a wedding (issue #33): who they are, where the contract stands, and what is owed when. Money is tracked, never moved: integer cents, no payment provider. The couple sees a vendor only when the planner shares it. Stored under groupedKey(wedding_id, vendor_id) and read one wedding at a time.
 */
export interface WeddingVendor {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
vendor_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * What they provide, from a fixed list; `other` with `category_other` naming it.
 */
category: ("venue" | "catering" | "photography" | "videography" | "music" | "flowers" | "attire" | "beauty" | "cake" | "transport" | "officiant" | "stationery" | "rentals" | "other")
/**
 * The category's name when `category` is `other`.
 */
category_other?: string
business_name: string
contact_name?: string
email?: string
phone?: string
contract_status: ("none" | "sent" | "signed" | "cancelled")
/**
 * The payment schedule, in order. At most 24 (enforced by the vendor service: a maxItems here would generate a tuple type).
 */
installments: {
/**
 * Stable across edits of the schedule.
 */
installment_id: string
/**
 * What it is for (e.g. 'Deposit', 'Final payment').
 */
label: string
/**
 * The amount in integer cents (never a float).
 */
amount_cents: number
due_date: string
/**
 * Whether this installment is the deposit (at most one per vendor).
 */
deposit: boolean
paid: boolean
/**
 * ISO 8601 UTC time it was marked paid, while paid.
 */
paid_at?: string
}[]
/**
 * Whether the wedding's couple sees this vendor (the planner's call).
 */
shared_with_couple: boolean
notes?: string
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last change, when changed.
 */
updated_at?: string
}
