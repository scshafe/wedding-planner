/* eslint-disable */
/**
 * GENERATED from product/schemas/seating_table_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One table of a wedding's seating plan (issue #46): a name and how many guests it seats. Stored under groupedKey(wedding_id, table_id).
 */
export interface SeatingTable {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
table_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
name: string
/**
 * How many guests it seats.
 */
capacity: number
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last change, when changed.
 */
updated_at?: string
}
