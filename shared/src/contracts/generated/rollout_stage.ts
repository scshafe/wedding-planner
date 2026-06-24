/* eslint-disable */
/**
 * GENERATED from loop-orchestrator/schemas/rollout_stage_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * Configuration and live state of one production validation stage for a candidate. The experiment engine reads/writes these; the circuit breakers act on them. See experiment_design.md.
 */
export interface RolloutStage {
candidate_id: string
/**
 * shadow = parallel, NO real-world action, inertness enforced at network egress (sandbox proxy), carries canary-grade guardrails. canary = small sticky cohort. ramp = increasing cohort (see ramp_step_index). full = promoted.
 */
stage: ("shadow" | "canary" | "ramp" | "full")
/**
 * Which step of the ramp ladder this stage represents (set when stage=ramp); a new rollout_stage record is created per step so step history is preserved.
 */
ramp_step_index?: (number | null)
/**
 * Percent of newly-onboarded couples (or clusters) assigned to the candidate. 0 in shadow.
 */
exposure_pct: number
assignment: {
/**
 * region_date_cluster (region x wedding-date-window) is REQUIRED for any candidate touching venue/catering/music/budget_management — shared finite vendor inventory makes per-couple assignment violate SUTVA (one arm cannibalizes the other's supply). Non-booking candidates may use couple_onboarding_cohort. See experiment_design.md.
 */
unit: ("couple_onboarding_cohort" | "region_date_cluster")
/**
 * Must be true: a couple does not flip between control and candidate mid-planning.
 */
sticky: boolean
/**
 * Must match the randomization unit; cluster-randomized experiments analyze at the cluster level (or a region x month mixed model).
 */
analysis_unit?: ("couple" | "region_date_cluster")
/**
 * For thin clusters: vary the within-cluster exposed fraction to estimate the spillover/interference slope.
 */
saturation?: {
enabled?: boolean
cluster_exposure_fraction?: (number | null)
}
}
/**
 * The VALIDATED leading-indicator metric the decision is made on (NOT the lagging wedding outcome). Only an indicator that cleared surrogate validation (Prentice/PTE) may be a primary. e.g. couple_active_minutes_total, rsvp_resolution_rate, north_star_ratio (eval-mirrored).
 */
primary_metric_code: string
/**
 * Monitored continuously for HARM, independent of the primary. Breach -> auto-rollback without waiting for primary significance.
 */
guardrail_metric_codes: string[]
/**
 * Always-valid (sequential) inference so continuous peeking is legitimate. Knobs are pinned and recorded so a readout is reproducible.
 */
stats?: {
/**
 * e-values/confidence sequences preferred (compose with online FDR). mSPRT requires tau_squared pinned to the MDE. A Bayesian variant is valid ONLY as a proper sequential test with simulated operating characteristics.
 */
method?: ("e_values_confidence_sequence" | "mSPRT" | "sequential_bayesian_PROPER_TEST_ONLY")
/**
 * Couple/cluster onboardings per week (by region/season); the denominator of every power and duration claim.
 */
expected_arrival_rate?: (number | null)
/**
 * Minimum detectable effect. Required before a promote decision; min_exposure_count is DERIVED from this, not asserted independently.
 */
mde?: (number | null)
/**
 * Target power (1 - beta).
 */
power_target?: (number | null)
/**
 * mSPRT mixture variance, pinned to the MDE; set when method=mSPRT.
 */
tau_squared?: (number | null)
/**
 * Prior/e-process specification; set when method requires it. Recorded for reproducibility.
 */
prior_spec?: (string | null)
alpha?: (number | null)
/**
 * Promote test is one_sided.
 */
sidedness?: ("one_sided" | "two_sided")
/**
 * Minimum assigned couples/clusters before a promote decision; DERIVED from mde + power_target via a sequential expected-sample-size analysis.
 */
min_exposure_count?: number
/**
 * Strictly positive. Must cover the leading metric's event horizon; time-to-event leading metrics use a survival estimator, not a rate at an arbitrary cutoff.
 */
min_duration_days?: number
primary_estimate?: (number | null)
/**
 * Always-valid (sequential) lower bound.
 */
ci_low?: (number | null)
ci_high?: (number | null)
/**
 * Measured rho^2 variance reduction; the power credit for CUPED is gated on this, not assumed.
 */
cuped_variance_reduction_achieved?: (number | null)
/**
 * ONLINE FDR over the continuous experiment stream (ADDIS when most candidates are null). Benjamini-Hochberg is BATCH_ONLY — valid for a fixed retrospective family, NEVER the live promote gate.
 */
false_discovery_control?: ("LORD_plus_plus" | "SAFFRON" | "ADDIS" | "benjamini_hochberg_BATCH_ONLY" | "none_PROHIBITED")
/**
 * How the primary is estimated. north_star_ratio is zero-inflated & bounded — do not analyze as a raw mean.
 */
estimand?: {
/**
 * Analyze gate-failure rate and among-passers quality separately.
 */
decompose_zero_inflation?: boolean
/**
 * Bounded ratios are regression-adjusted on a variance-stabilized scale, not raw.
 */
scale?: ("raw" | "logit" | "variance_stabilized")
/**
 * Report CDF shift / quantile treatment effects, not just the mean (catch lower-tail harm).
 */
report_quantile_effects?: boolean
}
}
/**
 * Persona-mirrored cohorts (low-budget, two-cultures, multilingual-guest-heavy) to check for heterogeneity.
 */
segments_monitored?: string[]
/**
 * Per-segment effect from a hierarchical / partial-pooling (shrinkage) model, tested as non-inferiority against a harm margin with BH across this FIXED segment family. Records 'we couldn't tell' distinctly from 'no harm'.
 */
segment_results?: {
segment: string
estimate: number
/**
 * [low, high].
 */
ci?: number[]
/**
 * False => underpowered: 'no harm detected' is NOT 'no harm'.
 */
powered: boolean
}[]
/**
 * Early-tenure vs mature-tenure within the candidate arm; a gain that decays with tenure is a novelty artifact.
 */
novelty_check?: {
early_tenure_estimate?: (number | null)
mature_tenure_estimate?: (number | null)
decay_flag?: boolean
}
/**
 * For booking candidates: set when the control arm's booking-success degrades coincident with candidate ramp — an interference signal, not a candidate win.
 */
control_arm_interference_flag?: boolean
/**
 * Real-time harm monitors. Trip => immediate auto-rollback, logged by decided_by=circuit_breaker.
 */
circuit_breakers: {
/**
 * Production analogue of a veto gate or critical guard, e.g. unauthorized_commit_count, qa_accuracy_rate.
 */
metric_code: string
/**
 * hard_veto = zero-event counter (e.g. unauthorized_commit_count): trip on first occurrence, no sequential test. sequential_rate = noisy rate (e.g. qa_accuracy_rate): trip via a one-sided sequential harm test, NOT a fixed threshold (which is itself uncontrolled peeking).
 */
breaker_type: ("hard_veto" | "sequential_rate")
/**
 * For hard_veto: the count (typically >=1) that trips. Null for sequential_rate.
 */
threshold?: (number | null)
/**
 * For sequential_rate: the harmful effect size the sequential test is tuned to detect.
 */
harm_mde?: (number | null)
/**
 * For sequential_rate: the controlled false-rollback rate.
 */
false_alarm_rate?: (number | null)
/**
 * MUST be an out-of-band / trusted source the product cannot author — never the product's self-reported stream. See safety_and_governance.md §3.
 */
source: ("out_of_band_payment_processor" | "out_of_band_vendor_confirmation" | "out_of_band_complaint_channel" | "harness_trusted_record")
/**
 * There is only one action — a breaker reverts, it does not page-and-wait.
 */
action: "auto_rollback"
}[]
/**
 * The engine's current call for this stage.
 */
decision: ("continue" | "promote" | "rollback" | "hold")
}
