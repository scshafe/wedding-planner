/* eslint-disable */
/**
 * GENERATED from product/schemas/run_of_show_item_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One item of a wedding's run of show (issue #45): what happens when on the day, who owns it, and — for a vendor's item — when that vendor must arrive. Stored under groupedKey(wedding_id, item_id) and read one wedding at a time.
 */
export interface RunOfShowItem {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
item_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * Local date and time it starts (YYYY-MM-DDTHH:MM, like the wedding's events).
 */
starts_at: string
/**
 * Local date and time it ends, when it has an end (not before it starts).
 */
ends_at?: string
title: string
location?: string
/**
 * Who owns it: the planner, the couple, or one of the wedding's vendors (owner_vendor_id).
 */
owner: ("planner" | "couple" | "vendor")
/**
 * The vendor (of the same wedding) who owns it, when owner is vendor.
 */
owner_vendor_id?: string
/**
 * When the owning vendor must arrive, for a vendor's item (local date and time).
 */
vendor_call_time?: string
/**
 * The wedding event (issue #29) it belongs to, when it belongs to one.
 */
event_id?: string
/**
 * The planner's notes (the couple does not see them).
 */
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
