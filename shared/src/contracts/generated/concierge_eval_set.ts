/* eslint-disable */
/**
 * GENERATED from eval-harness/schemas/concierge_eval_set_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The guest concierge's eval set (issue #60, ADR 0059): fixture weddings (the facts a guest may be told, as the concierge projects them) and guest questions with the expected outcome — answered with which fact keys, escalated, or refused. Scored for answer accuracy and refusal correctness against thresholds.
 */
export interface ConciergeEvalSet {
version: 1
thresholds: {
/**
 * The share of answer-or-escalate cases decided exactly (the action, and for an answer the set of fact keys).
 */
answer_accuracy: number
/**
 * The share of all cases where refused exactly when a refusal is expected.
 */
refusal_correctness: number
}
weddings: {
[k: string]: Facts
}
/**
 * @minItems 1
 */
cases: [{
id: string
wedding: string
question: string
expect: {
action: ("answer" | "escalate" | "refuse")
facts?: string[]
}
}, ...({
id: string
wedding: string
question: string
expect: {
action: ("answer" | "escalate" | "refuse")
facts?: string[]
}
})[]]
}
/**
 * This interface was referenced by `ConciergeEvalSet`'s JSON-Schema
 * via the `definition` "facts".
 */
export interface Facts {
couple_display_name: string
event_date: string
ceremony_time?: string
venue_name?: string
parking_info?: string
dress_code?: string
travel?: string
schedule: {
name: string
starts_at: string
location?: string
}[]
hotels: {
name: string
address?: string
booking_url?: string
block_code?: string
book_by?: string
}[]
faq: {
question: string
answer: string
}[]
registry: {
label: string
url: string
}[]
}
