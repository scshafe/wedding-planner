/* eslint-disable */
/**
 * GENERATED from eval-harness/schemas/scenario_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * Wires a couple persona + guest personas + injected world events + success criteria into one runnable eval case. A run consumes exactly one scenario and emits one grade report.
 */
export interface Scenario {
/**
 * Stable id; prefix matches scenario_type.
 */
scenario_id: string
/**
 * golden = known-good regression anchor; adversarial = designed to break the product.
 */
scenario_type: ("golden" | "adversarial")
/**
 * One line: the situation and what is being tested.
 */
description: string
/**
 * Which North Star pillar(s) this scenario stresses. Drives coverage tracking.
 */
focus: ("couple_effort" | "outcome_quality" | "guest_experience" | "integration_execution" | "ux_intuitiveness" | "trust_safety" | "business_viability")[]
/**
 * persona_id of the driving couple.
 */
couple_persona_ref: string
/**
 * persona_ids of guests participating.
 */
guest_persona_refs: string[]
/**
 * The vendor/availability world the run operates against.
 */
world_state: {
/**
 * 'fixture' = deterministic canned inventory (default for the loop); 'live_sandbox' = real integration sandboxes.
 */
mode: ("fixture" | "live_sandbox")
/**
 * Path to a vendor inventory fixture when mode=fixture.
 */
inventory_fixture_ref?: string
/**
 * Which 3rd-party categories are reachable in this run, e.g. ['venue_booking_api','catering_form','band_email_only'].
 */
available_integrations?: string[]
}
/**
 * Disruptions injected during the run to test recovery. Fired at the named phase.
 */
world_events?: {
event_id: string
/**
 * Lifecycle phase at which the event fires.
 */
at_phase: ("discovery" | "shortlist" | "booking" | "invitations_sent" | "rsvp_window" | "final_week" | "day_of")
event_type: ("vendor_cancellation" | "price_increase" | "availability_change" | "guest_count_change" | "budget_cut" | "new_constraint" | "integration_outage" | "guest_dispute")
/**
 * Event-specific data, e.g. {category:'catering', days_before: 14}.
 */
payload?: {

}
}[]
success_criteria: {
/**
 * Veto gates that must hold. A breach makes verdict=fail.
 */
gates_must_hold: ("BUDGET.CEILING_EXCEEDED" | "CONSTRAINT.HARD_VIOLATED" | "COMMS.FALSE_FACT_TO_GUEST" | "SPEND.UNAUTHORIZED_COMMIT" | "COMMS.SURPRISE_LEAK" | "COMMS.MIS_SEGMENTATION" | "INTEGRATION.SILENT_FAILURE" | "INTEGRATION.DOUBLE_BOOK")[]
/**
 * Quantitative thresholds expected for a good run.
 */
target_metrics: {
/**
 * e.g. budget_variance_pct, rsvp_resolution_rate, couple_active_minutes_total, autonomy_rate, qa_accuracy_rate, decision_reversal_rate.
 */
metric_code: string
direction: ("max" | "min" | "lte" | "gte" | "eq")
threshold: number
}[]
/**
 * For golden scenarios only: the known-good plan signature (booked categories, on-budget, all guests resolved). Used as a regression anchor.
 */
golden_expected_outcomes?: {
[k: string]: unknown
}
}
/**
 * Which LLM-judge rubrics apply to this scenario.
 */
graded_axes: ("vision_match" | "comms_quality" | "intuitiveness")[]
/**
 * Free-text context for graders.
 */
notes?: string
}
