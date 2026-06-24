/* eslint-disable */
/**
 * GENERATED from eval-harness/schemas/grade_report_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The output of one eval run. Uses the standard {data,error,meta} envelope. Consumed by the loop orchestrator to decide whether a candidate product change is accepted.
 */
export interface GradeReport {
data: ({
/**
 * Unique id for this run (injected, not ambient).
 */
run_id: string
scenario_id: string
couple_persona_ref?: string
guest_persona_refs?: string[]
/**
 * fail if any veto gate breached, regardless of North Star value.
 */
verdict: ("pass" | "fail")
/**
 * One entry per gate evaluated. Grading continues after a failure so the report shows how far off.
 */
gate_results: {
/**
 * e.g. BUDGET.CEILING_EXCEEDED, COMMS.FALSE_FACT_TO_GUEST, SPEND.UNAUTHORIZED_COMMIT.
 */
gate_code: string
passed: boolean
/**
 * Human-readable explanation.
 */
detail: string
/**
 * Trace references proving the result (message ids, action ids).
 */
evidence?: string[]
}[]
metric_results: {
metric_code: string
value: number
target: number
direction: ("max" | "min" | "lte" | "gte" | "eq")
passed: boolean
}[]
/**
 * LLM-judge results for graded axes. Auditable: each carries rationale and judge model id.
 */
rubric_scores?: {
rubric_code: ("vision_match" | "comms_quality" | "intuitiveness")
score: number
max_score: number
rationale: string
judge_model: string
}[]
/**
 * The apex objective components. See scoring/scoring_model.md.
 */
north_star: {
/**
 * Composite numerator: quality × completeness × guest_experience, normalized 0..1.
 */
planning_value: number
/**
 * Composite denominator: effort + money + stress, normalized.
 */
couple_cost: number
/**
 * planning_value / couple_cost, the score the loop maximizes (0 if any gate failed).
 */
ratio: number
}
/**
 * Attribution of the score to product capabilities so the loop knows what to change.
 */
per_capability_scorecard: {
capability: ("venue" | "catering" | "music" | "invitations" | "rsvp" | "guest_qa" | "seating" | "comms_personalization" | "budget_management" | "integration" | "orchestration")
/**
 * Normalized 0..1 contribution health for this capability.
 */
score: number
issues: string[]
}[]
/**
 * Failure modes observed in this run worth promoting into scenarios/adversarial/. Grows the harness over time.
 */
new_adversarial_candidates?: {
title: string
rationale: string
suggested_focus?: string[]
}[]
} | null)
/**
 * Set (and data=null) only when the run itself failed to execute, not when the product scored poorly.
 */
error: ({
/**
 * e.g. HARNESS.RUN_ABORTED, HARNESS.PRODUCT_UNREACHABLE.
 */
code?: string
message?: string
context?: {

}
} | null)
meta: {
harness_version: string
product_under_test_version?: string
/**
 * UTC, injected.
 */
started_at: string
/**
 * UTC, injected.
 */
finished_at: string
/**
 * Determinism seed for the run.
 */
seed?: string
}
}
