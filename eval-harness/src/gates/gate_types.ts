/**
 * @canonical gate_types -- the veto-gate vocabulary and result shape.
 *
 * The deterministic veto gates (eval-harness/rubrics/gate_checks.md). A GateResult matches one entry
 * of grade_report.gate_results[]. Every gate is a pure function whose security-relevant inputs come
 * from the TrustedRecorder and persona/scenario ground truth — never the product's self-report.
 *
 * related: trusted_recorder/trusted_recorder.ts, gates/* (the gate implementations).
 */
import type { CouplePersona, EventEnvelope, GuestPersona } from '@wedding-planner/shared'

import type { TrustedRecorder } from '../trusted_recorder/trusted_recorder'

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

/**
 * The inputs every gate reads. The security-relevant fields all come from the TrustedRecorder and
 * the persona/scenario ground truth; `productEvents` is used ONLY by the divergence-style gates
 * (INTEGRITY, INTEGRATION.SILENT_FAILURE) to compare a product claim against the trusted truth — and
 * even there the authoritative value is always the trusted record.
 */
export interface GateEvaluationContext {
  /** The trusted record of the product's actual sandboxed effects (the integrity boundary). */
  readonly recorder: TrustedRecorder
  /** The product's self-reported telemetry events — CLAIMS, used only by divergence-style gates. */
  readonly productEvents: readonly EventEnvelope[]
  /** The driving couple persona (budget, spend autonomy, hard constraints) — ground truth. */
  readonly couple: CouplePersona
  /** The participating guest personas — ground truth (expected answers, must_avoid). */
  readonly guests: readonly GuestPersona[]
  /** Booked-plan facts (fact_type -> correct value) for fact-checking guest comms — ground truth. */
  readonly bookedPlanFacts: Readonly<Record<string, string>>
}

/**
 * Build a veto-gate result from a list of violation evidence strings: the gate passes iff there are
 * no violations. Keeps every gate's result shape uniform.
 */
export function vetoGateResult(gateCode: string, evidence: readonly string[]): GateResult {
  return {
    gate_code: gateCode,
    passed: evidence.length === 0,
    detail:
      evidence.length === 0
        ? `${gateCode} holds`
        : `${gateCode} failed: ${evidence.length} violation(s)`,
    evidence,
  }
}
