/**
 * @canonical gate_types -- the veto-gate vocabulary and result shape.
 *
 * The deterministic veto gates (eval-harness/rubrics/gate_checks.md). A GateResult matches one entry
 * of grade_report.gate_results[]. Every gate is a pure function whose security-relevant inputs come
 * from the TrustedRecorder and persona/scenario ground truth — never the product's self-report.
 *
 * related: trusted_recorder/trusted_recorder.ts, gates/* (the gate implementations).
 */

export const GATE_CODES = {
  BUDGET_CEILING_EXCEEDED: 'BUDGET.CEILING_EXCEEDED',
  CONSTRAINT_HARD_VIOLATED: 'CONSTRAINT.HARD_VIOLATED',
  COMMS_FALSE_FACT_TO_GUEST: 'COMMS.FALSE_FACT_TO_GUEST',
  SPEND_UNAUTHORIZED_COMMIT: 'SPEND.UNAUTHORIZED_COMMIT',
  COMMS_SURPRISE_LEAK: 'COMMS.SURPRISE_LEAK',
  COMMS_MIS_SEGMENTATION: 'COMMS.MIS_SEGMENTATION',
  INTEGRATION_SILENT_FAILURE: 'INTEGRATION.SILENT_FAILURE',
  INTEGRATION_DOUBLE_BOOK: 'INTEGRATION.DOUBLE_BOOK',
  INTEGRITY_SELF_REPORT_DIVERGENCE: 'INTEGRITY.SELF_REPORT_DIVERGENCE',
} as const

export type GateCode = (typeof GATE_CODES)[keyof typeof GATE_CODES]

/** The result of evaluating one veto gate. Matches grade_report.gate_results[]. */
export interface GateResult {
  readonly gate_code: string
  readonly passed: boolean
  /** Human-readable explanation of the result. */
  readonly detail: string
  /** Trace references proving the result (effect ids, message ids). */
  readonly evidence: readonly string[]
}
