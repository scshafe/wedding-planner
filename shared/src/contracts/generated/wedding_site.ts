/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_site_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A wedding's public website (issue #47): what guests may read at /t/<slug>/w/<site_name> once it is published — the welcome, the public events, travel notes, hotel blocks, an FAQ and registry links. Never any guest data. One per wedding, stored under the wedding_id; the site name is unique in the workspace (the wedding_site_name index).
 */
export interface WeddingSite {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * The site's name in its public address: 3 to 40 lowercase letters, digits and hyphens (no underscores, so it never looks like an id).
 */
site_name: string
/**
 * Whether the public page is on. Off until published; off is the generic not-found.
 */
published: boolean
welcome?: string
/**
 * Travel notes: how to get there, parking, transport.
 */
travel?: string
/**
 * The wedding's events (issue #29) shown in the public schedule: name, time and place only.
 */
public_event_ids: string[]
/**
 * Hotel blocks (at most 10, enforced by the site service).
 */
hotels: {
hotel_id: string
name: string
address?: string
booking_url?: string
block_code?: string
book_by?: string
}[]
/**
 * Questions and answers (at most 30, enforced by the site service).
 */
faq: {
faq_id: string
question: string
answer: string
}[]
/**
 * Registry links (at most 10, enforced by the site service); https only.
 */
registry: {
registry_id: string
label: string
url: string
}[]
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last change, when changed.
 */
updated_at?: string
}
