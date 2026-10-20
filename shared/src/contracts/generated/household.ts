/* eslint-disable */
/**
 * GENERATED from product/schemas/household_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A party of guests invited together to one wedding (issue #27): a couple, a family, a single guest. Owned by one tenant and one wedding; always reached through a tenant-scoped repository keyed (tenant_id, household_id) and filtered by wedding_id. A household is the unit an RSVP link is sent to (M2).
 */
export interface Household {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
household_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
/**
 * The wedding the household is invited to (verified to exist in the tenant at creation).
 */
wedding_id: string
/**
 * The party's name as the couple addresses it, e.g. 'The Rivera family'.
 */
name: string
/**
 * Optional mailing address (free text). Personal data: never logged, shown only to the wedding's planner and couple.
 */
address?: string
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
}
