/* eslint-disable */
/**
 * GENERATED from telemetry/schemas/event_envelope_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The common envelope every telemetry event conforms to, emitted identically by the eval harness (source=eval) and production (source=production). The payload shape depends on event_name; payloads for safety-critical events are defined in event_payloads_schema.json, the rest in event_catalog.md.
 */
export interface TelemetryEventEnvelope {
/**
 * Unique id for this event. Injected, never ambient — required for deterministic replay.
 */
event_id: string
/**
 * Dot-delimited event name matching the module/domain path, e.g. 'commitment.executed', 'guest.question.answered'. See event_catalog.md for the full set.
 */
event_name: string
/**
 * ISO 8601 UTC. Injected, never read from an ambient clock.
 */
occurred_at: string
/**
 * Correlates all events of one run (eval) or one planning session/lifecycle (production).
 */
trace_id: string
/**
 * The wedding being planned — the aggregate root all metrics group by.
 */
wedding_id: string
/**
 * Lifecycle phase. See vocabularies.md#phase.
 */
phase: ("discovery" | "shortlist" | "booking" | "invitations_sent" | "rsvp_window" | "final_week" | "day_of" | "post")
/**
 * Which product capability emitted the event. Powers the per_capability_scorecard. See vocabularies.md#capability.
 */
capability: ("venue" | "catering" | "music" | "invitations" | "rsvp" | "guest_qa" | "seating" | "comms_personalization" | "budget_management" | "integration" | "orchestration")
/**
 * Who or what triggered the event. See vocabularies.md#actor.
 */
actor: ("couple" | "guest" | "ai" | "vendor" | "system")
/**
 * Whether this event came from an eval run or production. The schema is identical for both.
 */
source: ("eval" | "production")
/**
 * Present on guest-scoped events. An identifier only — never raw PII.
 */
guest_id?: (string | null)
/**
 * Event-specific data. Carries identifiers, not raw PII (see README privacy discipline). Safety-critical payloads are constrained in event_payloads_schema.json; others are specified in event_catalog.md and should be materialized as JSON Schema as the product is built.
 */
payload: {

}
meta: {
/**
 * Version of this telemetry contract the event was emitted under.
 */
schema_version: string
/**
 * Set when source=eval.
 */
harness_version?: (string | null)
/**
 * Set when source=production (or the product-under-test version in eval).
 */
product_version?: (string | null)
/**
 * Run determinism seed; set when source=eval.
 */
seed?: (string | null)
}
}
