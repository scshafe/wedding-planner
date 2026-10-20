/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_event_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One event of a wedding (issue #29): the ceremony, the reception, a rehearsal dinner. Guests answer an RSVP per event. Owned by one tenant and one wedding; stored under groupedKey(wedding_id, event_id) and read one wedding at a time.
 */
export interface WeddingEvent {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
event_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
/**
 * The wedding the event belongs to.
 */
wedding_id: string
name: string
/**
 * The local date and time the event starts (YYYY-MM-DDTHH:MM, no zone: the time on the invitation, where the event is).
 */
starts_at: string
/**
 * Where it happens (free text), when known.
 */
location?: string
/**
 * Who is invited when a guest has no RSVP record for this event: every guest, or only the guests marked invited (an invite-only rehearsal dinner). A plus-one without a record follows their host.
 */
invitation: ("everyone" | "selected")
/**
 * The meals a guest can choose at this event; empty when there is no meal choice. At most 8 (enforced by the event service: a maxItems here would generate a tuple type).
 */
meal_options: {
/**
 * Stable across label edits (an edit that names the option_id renames it in place), so a guest's choice survives a renamed meal.
 */
option_id: string
label: string
}[]
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last edit, when edited.
 */
updated_at?: string
}
