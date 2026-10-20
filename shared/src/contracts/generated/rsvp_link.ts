/* eslint-disable */
/**
 * GENERATED from product/schemas/rsvp_link_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A household's RSVP link (issue #30): the link's token is stored only as its SHA-256 hash. Kept twice, in the same shape: under the hash (to resolve a link) and under groupedKey(wedding_id, household_id) (the household's current link, so making a new one turns the old one off). Removed with the household.
 */
export interface RsvpLink {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * The household of the same wedding the link answers for.
 */
household_id: string
/**
 * SHA-256 of the token, hex. The token itself is never stored.
 */
token_hash: string
/**
 * ISO 8601 UTC time the link was made, from the injected clock.
 */
created_at: string
}
