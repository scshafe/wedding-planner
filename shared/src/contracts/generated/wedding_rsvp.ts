/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_rsvp_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One guest's answer for one event of a wedding (issue #29). Stored under groupedKey(wedding_id, `${event_id}:${guest_id}`). No record means the default: the event's invitation (a plus-one follows their host), pending. Removed with its guest or its event.
 */
export interface WeddingRsvp {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * An event of the same wedding.
 */
event_id: string
/**
 * A guest (wedding_guest) of the same wedding.
 */
guest_id: string
/**
 * Whether the guest is invited to this event (overrides the event's invitation default). A guest not invited has no answer (status pending).
 */
invited: boolean
status: ("pending" | "attending" | "declined")
/**
 * One of the event's meal options; only while attending.
 */
meal_option_id?: string
/**
 * Who recorded the current answer: the planner or the couple in the console, or the household on its RSVP page (issue #30).
 */
answered_by: ("planner" | "couple" | "household")
/**
 * ISO 8601 UTC time of the last change, from the injected clock.
 */
updated_at: string
}
