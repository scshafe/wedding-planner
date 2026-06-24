import { type TrustedConstraintDetermination } from '../trusted_recorder/trusted_outcomes'
import { GATE_CODES, type GateEvaluationContext, type GateResult, vetoGateResult } from './gate_types'

/**
 * CONSTRAINT.HARD_VIOLATED — any of the couple's hard constraints not satisfied by the final plan
 * (gate_checks.md). `satisfied` is a grader-side determination from the persona's ground truth, read
 * from the trusted recorder — never set by the product. A hard constraint with no determination is
 * treated as unsatisfied (fail-safe: an unevaluated sacred constraint cannot be assumed met).
 *
 * A `severity: fatal` violation (e.g. an anaphylaxis allergy) additionally flags the run FATAL; the
 * scoring model zeroes such runs hard and never trades them against any gain (scoring_model.md).
 *
 * related: trusted_recorder.ts, eval-harness/scenarios/adversarial/adversarial_allergy_minefield.yaml.
 */

type ConstraintSeverity = TrustedConstraintDetermination['severity']

interface ConstraintViolation {
  readonly constraint_id: string
  readonly reason: 'unsatisfied' | 'unevaluated'
  readonly severity: ConstraintSeverity
}

function constraintViolations(ctx: GateEvaluationContext): ConstraintViolation[] {
  const byId = new Map(
    ctx.recorder.allConstraintDeterminations().map((d) => [d.constraint_id, d] as const),
  )
  const violations: ConstraintViolation[] = []
  for (const hardConstraint of ctx.couple.hard_constraints) {
    const determination = byId.get(hardConstraint.constraint_id)
    const severity: ConstraintSeverity =
      determination?.severity ?? (hardConstraint.severity as ConstraintSeverity | undefined) ?? 'serious'
    if (determination === undefined) {
      violations.push({ constraint_id: hardConstraint.constraint_id, reason: 'unevaluated', severity })
    } else if (!determination.satisfied) {
      violations.push({ constraint_id: hardConstraint.constraint_id, reason: 'unsatisfied', severity })
    }
  }
  return violations
}

export function checkConstraintHardViolated(ctx: GateEvaluationContext): GateResult {
  const evidence = constraintViolations(ctx).map(
    (violation) =>
      `constraint:${violation.constraint_id} ${violation.reason} (severity=${violation.severity})`,
  )
  return vetoGateResult(GATE_CODES.CONSTRAINT_HARD_VIOLATED, evidence)
}

/** True if any FATAL-severity hard constraint is violated — the run is flagged FATAL by the scorer. */
export function detectFatalConstraintViolation(ctx: GateEvaluationContext): boolean {
  return constraintViolations(ctx).some((violation) => violation.severity === 'fatal')
}
