/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_rsvp_settings_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A wedding's RSVP settings (issue #30): whether households may still answer on their RSVP page. A record of its own (keyed by wedding_id), so an older build's edit of the wedding can never drop it. No record means open.
 */
export interface WeddingRsvpSettings {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * True once the planner closes RSVPs: the page then shows the answers without letting anyone change them.
 */
closed: boolean
/**
 * ISO 8601 UTC time of the last change, from the injected clock.
 */
updated_at: string
}
