/* eslint-disable */
/**
 * GENERATED from eval-harness/schemas/guest_persona_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * Seed definition of a simulated guest. An LLM role-player consumes this to interact with the product's guest-facing surface (invitations, RSVP, Q&A). Carries ground-truth answers so comms accuracy is checkable rather than subjective.
 */
export interface GuestPersona {
/**
 * Stable identifier, e.g. guest_multilingual_dietary.
 */
persona_id: string
/**
 * One line: who this guest is and what they stress.
 */
description: string
relationship: {
/**
 * e.g. 'grandmother', 'college friend', 'coworker'.
 */
to_couple: string
side: ("partner_a" | "partner_b" | "both")
/**
 * Calibrates expected warmth/formality of tailored comms.
 */
closeness?: ("inner_circle" | "close" | "extended" | "acquaintance")
}
contact: {
preferred_channel: ("email" | "sms" | "whatsapp" | "postal" | "phone")
/**
 * BCP-47 tag, e.g. 'es', 'en', 'tl'. Comms in the wrong language is a personalization penalty.
 */
preferred_language: string
/**
 * 'unreachable_digitally' (e.g. elderly relative) forces postal/phone fallback.
 */
reachability?: ("reliable" | "intermittent" | "unreachable_digitally")
}
dietary_restrictions?: {
/**
 * e.g. 'tree_nut_allergy', 'vegan', 'kosher', 'celiac'.
 */
restriction: string
/**
 * 'fatal'/'medical' link to allergy hard-constraint checks.
 */
severity: ("fatal" | "medical" | "preference")
}[]
/**
 * e.g. 'wheelchair_access', 'asl_interpreter', 'low_vision_materials'.
 */
accessibility_needs?: string[]
travel?: {
coming_from?: string
needs_accommodation?: boolean
needs_travel_info?: boolean
}
plus_one?: {
/**
 * 'disputed' = guest will push for a plus-one they were not given; tests boundary-holding comms.
 */
status: ("granted" | "not_granted" | "disputed")
dispute_intensity?: ("none" | "mild" | "persistent")
}
/**
 * Ground truth of how this guest behaves; used to score RSVP resolution accuracy and prompting effectiveness.
 */
rsvp_truth: {
/**
 * Final intent. 'maybe_needs_nudge' only converts with appropriate follow-up.
 */
will_attend: ("yes" | "no" | "maybe_needs_nudge")
response_latency: ("immediate" | "after_one_reminder" | "after_multiple_reminders" | "never")
/**
 * Headcount this guest represents on a 'yes'.
 */
party_size?: number
}
/**
 * Scripted questions this guest will ask. Each carries the ground-truth answer so COMMS.FALSE_FACT_TO_GUEST and Q&A accuracy are deterministically checkable.
 */
questions: {
question_id: string
/**
 * What the guest asks.
 */
text: string
/**
 * Ground-truth correct answer, derived from scenario world state.
 */
expected_answer: string
/**
 * 'requires_couple' must escalate; 'must_refuse' is a trap (e.g. asking to reveal a surprise) the AI must decline.
 */
answerable_by: ("ai_from_known_facts" | "requires_couple" | "must_refuse")
/**
 * True if a wrong response is a gate failure (surprise leak, fabricated fact).
 */
is_trap?: boolean
}[]
/**
 * What good tailored communication looks like for this guest; scored by comms_quality_rubric.
 */
personalization_expectations: {
expected_tone: ("warm_familial" | "friendly_peer" | "respectful_formal" | "playful")
/**
 * BCP-47 tag the guest should be addressed in.
 */
expected_language: string
/**
 * Content this guest specifically needs, e.g. accessible-entrance info, kids-welcome note.
 */
must_include?: string[]
/**
 * e.g. surprise details, another guest's private info.
 */
must_avoid?: string[]
}
}
