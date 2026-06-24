/* eslint-disable */
/**
 * GENERATED from loop-orchestrator/schemas/candidate_change_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One unit the loop operates on: a versioned, reversible, attributed mutation to the product under test, proposed with a falsifiable hypothesis. The proposer emits these; the deterministic selector and experiment engine decide their fate.
 */
export interface CandidateChange {
/**
 * Stable id, injected (not ambient).
 */
candidate_id: string
/**
 * UTC, injected.
 */
created_at: string
/**
 * Autonomous proposals are ai_proposer; objective/grader/corpus changes must be human (see safety_and_governance.md).
 */
author: ("ai_proposer" | "human")
/**
 * What the change is predicted to do, stated falsifiably so the selector can check whether it worked AND whether it worked for the claimed reason.
 */
hypothesis: {
/**
 * The one capability this change primarily targets. Invariant: target_capability MUST be a member of change.capabilities_touched (enforced at offline_scoring).
 */
target_capability: ("venue" | "catering" | "music" | "invitations" | "rsvp" | "guest_qa" | "seating" | "comms_personalization" | "budget_management" | "integration" | "orchestration")
/**
 * The primary metric this change aims to move. VALIDATION CONTRACT: the selector resolves this against ../telemetry/metric_catalog.md at implemented->offline_scoring; an unresolvable code (e.g. a typo) auto-rejects the candidate — a typo'd target would otherwise silently fail hypothesis_confirmed and mis-route to human review.
 */
target_metric_code: string
/**
 * The scenarios expected to improve most.
 */
target_scenario_ids?: string[]
expected_direction: ("increase" | "decrease")
/**
 * Optional predicted effect size; compared to ledger offline_result.observed_target_delta. A big aggregate gain via an unhypothesized path (low target_attribution_share) is treated as suspect.
 */
expected_magnitude?: (number | null)
/**
 * The paired counter-metrics from the catalog that must NOT regress. Also resolved against the catalog at offline_scoring; unresolvable codes auto-reject.
 */
guards_to_watch: string[]
/**
 * Why the proposer believes this will work; grounded in the scorecard/ledger/adversarial candidate that motivated it.
 */
rationale: string
}
change: {
/**
 * weights_PROHIBITED is listed only so a proposer attempting to tune the objective is rejected explicitly, not silently.
 */
change_type: ("prompt" | "tool" | "flow" | "integration" | "config" | "ranking" | "copy" | "weights_PROHIBITED")
/**
 * One line a human reviewer can act on.
 */
summary: string
/**
 * Branch/commit/flag identifying the change. Must be atomically revertible.
 */
artifact_ref: string
/**
 * Must be true to advance past offline. A change that cannot be cleanly reverted is rejected.
 */
reversible: boolean
/**
 * A CLAIM by the proposer, NOT authoritative. The authoritative risk_tier is derived from a static analysis of the diff (see ../risk_tier_derivation.md); this field is cross-checked against that derivation and an under-declaration is auto-rejected and escalated as a firewall-evasion signal. Also seeds segment monitoring.
 */
capabilities_touched: string[]
/**
 * True if rolling this back partway through a couple's 12-18 month engagement leaves no orphaned state. Required for production stages.
 */
mid_engagement_safe?: boolean
}
/**
 * 0 = cosmetic/ranking (offline+canary, auto). 1 = flow/non-binding tools (adds shadow + human notify). 2 = money/guest-comms/bookings/PII (adds human approval gate + slow ramp). 3 = objective/graders/corpus/spend-model/legal — PROHIBITED for ai_proposer. See safety_and_governance.md.
 */
risk_tier: (0 | 1 | 2 | 3)
/**
 * candidate_ids this builds on; prevents stacking unvalidated changes.
 */
depends_on?: string[]
/**
 * Current position in the stage machine (loop_architecture.md).
 */
status: ("proposed" | "implemented" | "offline_scoring" | "offline_rejected" | "offline_passed" | "human_review" | "human_rejected" | "shadow" | "canary" | "ramp" | "promoted" | "rolled_back" | "parked")
}
