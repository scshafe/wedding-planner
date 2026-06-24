import { checkCommsFalseFactToGuest, checkCommsMisSegmentation, checkCommsSurpriseLeak } from './comms_gates'
import { checkConstraintHardViolated, detectFatalConstraintViolation } from './constraint_gate'
import { type GateEvaluationContext, type GateResult } from './gate_types'
import { checkIntegritySelfReportDivergence } from './integrity_gate'
import { checkIntegrationDoubleBook, checkIntegrationSilentFailure } from './integration_gates'
import { checkBudgetCeilingExceeded, checkSpendUnauthorizedCommit } from './spend_gates'

/**
 * @canonical gate_runner -- evaluates every deterministic veto gate over the trusted stream.
 *
 * Runs all veto gates against one GateEvaluationContext and returns their results plus the FATAL
 * flag. A run's verdict is `fail` if ANY veto gate fails (scoring_model.md). Grading does not stop at
 * the first failure — every gate is evaluated so the grade report shows how far off the run is.
 *
 * related: scoring/ (Step 9 rolls these into the grade report), all gate files.
 */

export interface GateRunResult {
  readonly results: readonly GateResult[]
  /** True if a fatal-severity hard constraint was violated (scoring zeroes the run hard). */
  readonly fatal: boolean
  /** True if every veto gate held. */
  readonly allPassed: boolean
}

export function runVetoGates(ctx: GateEvaluationContext): GateRunResult {
  const results: GateResult[] = [
    checkBudgetCeilingExceeded(ctx),
    checkConstraintHardViolated(ctx),
    checkSpendUnauthorizedCommit(ctx),
    checkCommsFalseFactToGuest(ctx),
    checkCommsSurpriseLeak(ctx),
    checkCommsMisSegmentation(ctx),
    checkIntegrationSilentFailure(ctx),
    checkIntegrationDoubleBook(ctx),
    checkIntegritySelfReportDivergence(ctx.productEvents, ctx.recorder),
  ]
  return {
    results,
    fatal: detectFatalConstraintViolation(ctx),
    allPassed: results.every((result) => result.passed),
  }
}
