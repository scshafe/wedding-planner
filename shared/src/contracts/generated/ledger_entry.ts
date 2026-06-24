/* eslint-disable */
/**
 * GENERATED from loop-orchestrator/schemas/ledger_entry_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The durable, append-only audit record of one candidate's full journey through the loop: every state transition, who/what decided it, and the evidence. The ledger is the loop's memory — it makes decisions auditable and stops the proposer from re-trying dead ideas.
 */
export interface LedgerEntry {
ledger_id: string
candidate_id: string
/**
 * Append-only, hash-chained. Every move through the stage machine. Stored on a WORM substrate outside the proposer's write scope (safety_and_governance.md §7); each entry chains to the prior via prev_entry_hash so tampering is detectable.
 */
state_transitions: {
from_state: string
to_state: string
/**
 * UTC, injected.
 */
at: string
/**
 * The mechanism that made the decision; only deterministic mechanisms (not the proposer) advance a candidate. Authenticity is bound by decided_by_signature, not trusted as a bare string.
 */
decided_by: ("ai_proposer" | "deterministic_selector" | "risk_tier_gate" | "experiment_engine" | "circuit_breaker" | "human")
/**
 * Signature binding this transition to the actual deciding process's identity, so a forged entry cannot spoof decided_by.
 */
decided_by_signature: string
/**
 * Hash of this transition's content (incl. prev_entry_hash). The chain head.
 */
entry_hash: string
/**
 * entry_hash of the prior transition for this candidate; null for the first. Breaks if any earlier entry is altered.
 */
prev_entry_hash: (string | null)
rationale: string
/**
 * True when this transition required and performed a human notification (e.g. the Tier-1 'human notified' obligation), so the audit trail proves the notify happened.
 */
notified?: (boolean | null)
/**
 * Pointer to the grade reports / experiment readout backing the decision.
 */
evidence_ref?: (string | null)
}[]
/**
 * Outcome of scoring the candidate across the whole corpus, per scoring_model.md's accept rule.
 */
offline_result?: ({
/**
 * Change in mean north_star_ratio across the corpus (adversarial weighted >= golden).
 */
aggregate_north_star_delta?: number
/**
 * True if any golden scenario regressed — a hard stop.
 */
golden_regressed?: boolean
/**
 * Veto gates newly failing on any scenario (incl. FATAL flags).
 */
new_gate_failures?: string[]
/**
 * Counter-metrics that regressed beyond tolerance.
 */
guard_regressions?: string[]
/**
 * Did the target_metric move in the predicted direction on the predicted scenarios? Computed from the TRUSTED record, not product-emitted metrics (see telemetry Integrity). A gain WITHOUT this is suspect.
 */
hypothesis_confirmed?: boolean
/**
 * The actual measured movement of target_metric_code; compared to candidate.hypothesis.expected_magnitude.
 */
observed_target_delta?: (number | null)
/**
 * Fraction of the aggregate North Star gain attributable to the target scenarios. A large aggregate gain with LOW attribution share = the gain came from elsewhere than the declared mechanism = routed to human review (corpus-gaming signature). The surprise check tests magnitude+attribution, not just a boolean.
 */
target_attribution_share?: (number | null)
grade_report_refs?: string[]
} | null)
/**
 * Outcome of the production funnel.
 */
rollout_result?: ({
stage_reached?: ("shadow" | "canary" | "ramp" | "full")
/**
 * Estimated production effect on the primary metric.
 */
primary_effect?: (number | null)
/**
 * [low, high] always-valid confidence interval.
 */
primary_ci?: (number[] | null)
guardrail_status?: ("clean" | "breached")
/**
 * True if any monitored cohort showed harm (shrinkage estimate, non-inferiority vs margin) even when the average improved. See rollout_stage.segment_results.
 */
segment_harm_detected?: boolean
/**
 * True if any monitored segment could not be powered — 'no harm detected' there is NOT 'no harm', and blocks promote on that segment.
 */
segment_underpowered?: boolean
} | null)
/**
 * Null while in flight.
 */
final_disposition: ("promoted" | "rejected_offline" | "rejected_human" | "rolled_back" | "parked" | null)
/**
 * What the proposer should learn — including refs to adversarial scenarios created from this candidate's failures. Read by the proposer to avoid repeating dead ideas.
 */
lessons?: string[]
}
