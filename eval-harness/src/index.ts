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

// Trusted recorder (the integrity boundary — the harness's out-of-band record of real effects)
export { TrustedRecorder } from './trusted_recorder/trusted_recorder'
export {
  type TrustedCommitmentRecord,
  type TrustedIntegrationActionRecord,
  type RecordCommitmentInput,
  type RecordIntegrationActionInput,
  type VerifiedStatus,
} from './trusted_recorder/trusted_outcomes'

// Gates
export { GATE_CODES, type GateCode, type GateResult } from './gates/gate_types'
export {
  COMMITMENT_REPORT_EVENT_NAMES,
  INTEGRATION_REPORT_EVENT_NAMES,
} from './gates/report_event_names'
export {
  detectSelfReportDivergence,
  checkIntegritySelfReportDivergence,
  type SelfReportDivergence,
} from './gates/integrity_gate'
