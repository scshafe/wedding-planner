/**
 * @wedding-planner/eval-harness — the offline scoring substrate.
 *
 * Public barrel. The trusted recorder (the integrity boundary) authors security-relevant ground
 * truth; the deterministic veto gates read it (never the product's self-report); the scoring model
 * rolls results into the North Star grade report.
 */

export const EVAL_HARNESS_PACKAGE_NAME = '@wedding-planner/eval-harness'

// Errors
export { EvalHarnessError } from './eval_harness_error'

// Corpus loading (personas + scenarios as validated, typed ground truth)
export { loadCouplePersona, loadGuestPersona, loadScenario } from './corpus/corpus_loader'

// Trusted recorder (the integrity boundary — the harness's out-of-band record of real effects)
export { TrustedRecorder } from './trusted_recorder/trusted_recorder'
export {
  type TrustedCommitmentRecord,
  type TrustedIntegrationActionRecord,
  type TrustedConstraintDetermination,
  type TrustedGuestMessageRecord,
  type TrustedFactAssertion,
  type RecordCommitmentInput,
  type RecordIntegrationActionInput,
  type RecordConstraintDeterminationInput,
  type RecordGuestMessageInput,
  type TrustedSentimentObservationRecord,
  type RecordSentimentObservationInput,
  type TrustedVisionAlignmentRecord,
  type RecordVisionAlignmentInput,
  type VerifiedStatus,
} from './trusted_recorder/trusted_outcomes'

// Gates
export {
  GATE_CODES,
  vetoGateResult,
  type GateCode,
  type GateResult,
  type GateEvaluationContext,
} from './gates/gate_types'
export {
  COMMITMENT_REPORT_EVENT_NAMES,
  INTEGRATION_REPORT_EVENT_NAMES,
} from './gates/report_event_names'
export {
  detectSelfReportDivergence,
  checkIntegritySelfReportDivergence,
  type SelfReportDivergence,
} from './gates/integrity_gate'
export {
  budgetLimitCents,
  isAutoEligible,
  checkBudgetCeilingExceeded,
  checkSpendUnauthorizedCommit,
} from './gates/spend_gates'
export { checkConstraintHardViolated, detectFatalConstraintViolation } from './gates/constraint_gate'
export {
  checkCommsFalseFactToGuest,
  checkCommsSurpriseLeak,
  checkCommsMisSegmentation,
} from './gates/comms_gates'
export { checkIntegrationSilentFailure, checkIntegrationDoubleBook } from './gates/integration_gates'
export { runVetoGates, type GateRunResult } from './gates/gate_runner'

// Scoring (North Star + the corpus accept rule + grade report)
export {
  computeNorthStar,
  type NorthStar,
  type NorthStarComponentInputs,
} from './scoring/north_star'
export {
  evaluateAcceptRule,
  weightedMeanRatio,
  type AcceptDecision,
  type ScenarioRunResult,
  type ScenarioType,
  type GuardSpec,
} from './scoring/accept_rule'
export {
  buildGradeReport,
  type BuildGradeReportInput,
  type ScenarioTargetMetric,
} from './scoring/grade_report_builder'
export {
  PLANNING_VALUE_WEIGHTS,
  COUPLE_COST_WEIGHTS,
  AGGREGATION_WEIGHTS,
  ACCEPT_TOLERANCES,
  NORMALIZATION_ANCHORS,
  GUARD_DIRECTIONS,
} from './scoring/scoring_constants'
export {
  deriveNorthStarInputs,
  guardSpecsFor,
  type MetricValues,
} from './scoring/metric_normalization'
export {
  scoreCandidateOffline,
  type OfflineScoreResult,
  type PerScenarioScore,
  type ProductRunner,
  type ProductVariant,
  type ScenarioDefinition,
  type ScenarioExecution,
  type ScoreCandidateOfflineArgs,
} from './scoring/offline_scorer'

// Planner simulator (Phase 2): the offline product, Stage A (claims) / Stage B (trusted record),
// content-address-enforced. Turns the candidate-blind ProductRunner into a real, genome-driven one.
export {
  makePlannerSimulator,
  GenomeArtifactRefMismatchError,
  type PlannerSimulatorConfig,
} from './simulator/planner_simulator'
export { type Planner, type PlannerInput, rsvpCadencePlanner } from './simulator/stage_a_planner'
export { observeTrustedRecord } from './simulator/stage_b_observer'
