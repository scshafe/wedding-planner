/* eslint-disable */
/**
 * GENERATED from product/schemas/seat_assignment_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * Where one guest sits (issue #46): at most one table per guest, so it is keyed by the guest — groupedKey(wedding_id, guest_id). Removed with the guest (the guest list's hook) or with the table.
 */
export interface SeatAssignment {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * A guest (wedding_guest) of the same wedding.
 */
guest_id: string
/**
 * A table of the same wedding.
 */
table_id: string
/**
 * ISO 8601 UTC time the guest was seated there, from the injected clock.
 */
seated_at: string
}
