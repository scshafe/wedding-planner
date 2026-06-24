import { ACCEPT_TOLERANCES, AGGREGATION_WEIGHTS } from './scoring_constants'

/**
 * @canonical accept_rule -- the offline accept/reject decision over a whole corpus (scoring_model.md).
 *
 * A candidate is accepted for online A/B ONLY IF all four hold:
 *   1. No golden regression — every golden scenario still passes and stays within ratio tolerance.
 *   2. No new veto-gate failures on any scenario, and zero new FATAL flags.
 *   3. No counter-metric (Goodhart guard) regression beyond tolerance.
 *   4. Aggregate North Star improves — weighted mean ratio rises, adversarial weighted >= golden.
 *
 * The aggregate (condition 4) is reported with its zero-inflation decomposition (gate-failure rate
 * vs among-passers mean), because north_star_ratio is a bounded, zero-inflated quantity and a raw
 * mean hides which moved (scoring_model.md / experiment_design.md). Condition 2 already controls new
 * zeros, so the decomposition is a transparency surface here, and the load-bearing one in production.
 *
 * related: north_star.ts, grade_report_builder.ts, loop-orchestrator ledger offline_result.
 */

export type ScenarioType = 'golden' | 'adversarial'

/** The accept-rule-relevant summary of one scenario run. */
export interface ScenarioRunResult {
  readonly scenario_id: string
  readonly scenario_type: ScenarioType
  readonly verdict: 'pass' | 'fail'
  /** Gate codes that FAILED on this run. */
  readonly failed_gate_codes: readonly string[]
  readonly fatal: boolean
  readonly north_star_ratio: number
  /** Guard counter-metric values for this run (metric_code -> value). */
  readonly guard_metrics: Readonly<Record<string, number>>
}

/** A guard counter-metric and the direction in which a higher value is better/worse. */
export interface GuardSpec {
  readonly metric_code: string
  readonly direction: 'higher_better' | 'lower_better'
}

export interface AcceptDecision {
  readonly accepted: boolean
  /** True if candidate and baseline did not cover the same scenarios (not evaluable -> reject). */
  readonly corpus_mismatch: boolean
  readonly golden_regressed: boolean
  /** "scenario_id:gate_code" for each newly-failing gate. */
  readonly new_gate_failures: readonly string[]
  /** scenario_ids that newly flagged FATAL. */
  readonly new_fatal: readonly string[]
  /** "scenario_id:metric_code" for each guard that regressed beyond tolerance. */
  readonly guard_regressions: readonly string[]
  readonly baseline_weighted_mean: number
  readonly candidate_weighted_mean: number
  readonly aggregate_north_star_delta: number
  /** Zero-inflation decomposition. */
  readonly baseline_gate_failure_rate: number
  readonly candidate_gate_failure_rate: number
  readonly baseline_among_passers_mean: number
  readonly candidate_among_passers_mean: number
  readonly reasons: readonly string[]
}

function indexByScenario(
  runs: readonly ScenarioRunResult[],
): ReadonlyMap<string, ScenarioRunResult> {
  return new Map(runs.map((run) => [run.scenario_id, run] as const))
}

function aggregationWeight(type: ScenarioType): number {
  return type === 'golden' ? AGGREGATION_WEIGHTS.golden : AGGREGATION_WEIGHTS.adversarial
}

/** Weighted mean north_star_ratio across the corpus (adversarial weighted >= golden). */
export function weightedMeanRatio(runs: readonly ScenarioRunResult[]): number {
  if (runs.length === 0) {
    return 0
  }
  let weightedSum = 0
  let totalWeight = 0
  for (const run of runs) {
    const weight = aggregationWeight(run.scenario_type)
    weightedSum += run.north_star_ratio * weight
    totalWeight += weight
  }
  return totalWeight === 0 ? 0 : weightedSum / totalWeight
}

function gateFailureRate(runs: readonly ScenarioRunResult[]): number {
  if (runs.length === 0) {
    return 0
  }
  return runs.filter((run) => run.verdict === 'fail').length / runs.length
}

function amongPassersMean(runs: readonly ScenarioRunResult[]): number {
  const passers = runs.filter((run) => run.verdict === 'pass')
  if (passers.length === 0) {
    return 0
  }
  return passers.reduce((sum, run) => sum + run.north_star_ratio, 0) / passers.length
}

/**
 * Apply the four-condition accept rule. `baselineRuns` is the current product's corpus result;
 * `candidateRuns` is the candidate's. Both are keyed by scenario_id; a scenario present in one but
 * not the other is skipped for the per-scenario comparisons (the aggregate uses each set as given).
 */
export function evaluateAcceptRule(
  candidateRuns: readonly ScenarioRunResult[],
  baselineRuns: readonly ScenarioRunResult[],
  guards: readonly GuardSpec[] = [],
): AcceptDecision {
  const baselineByScenario = indexByScenario(baselineRuns)
  const reasons: string[] = []

  // Condition 0 (the firewall against corpus-composition gaming): the candidate is scored across the
  // WHOLE corpus (scoring_model.md), so it must cover exactly the same scenarios as the baseline.
  // Without this, a candidate could inflate the weighted-mean aggregate by ADDING easy scenarios or
  // DROPPING hard ones, and a candidate-only scenario would slip past the guard check — the canonical
  // Goodhart attack this model exists to stop. A mismatched corpus is not evaluable: reject.
  const candidateIds = new Set(candidateRuns.map((run) => run.scenario_id))
  const baselineIds = new Set(baselineRuns.map((run) => run.scenario_id))
  const missingFromCandidate = [...baselineIds].filter((id) => !candidateIds.has(id))
  const extraInCandidate = [...candidateIds].filter((id) => !baselineIds.has(id))
  const corpusMismatch = missingFromCandidate.length > 0 || extraInCandidate.length > 0
  if (corpusMismatch) {
    reasons.push(
      `corpus mismatch (candidate must cover the same scenarios as baseline): ` +
        `missing=[${missingFromCandidate.join(', ')}] extra=[${extraInCandidate.join(', ')}]`,
    )
  }

  // Condition 1: no golden regression.
  let goldenRegressed = false
  for (const candidate of candidateRuns) {
    if (candidate.scenario_type !== 'golden') {
      continue
    }
    const baseline = baselineByScenario.get(candidate.scenario_id)
    if (baseline === undefined) {
      continue
    }
    const verdictRegressed = baseline.verdict === 'pass' && candidate.verdict === 'fail'
    const ratioRegressed =
      candidate.north_star_ratio < baseline.north_star_ratio - ACCEPT_TOLERANCES.golden_ratio
    if (verdictRegressed || ratioRegressed) {
      goldenRegressed = true
      reasons.push(
        `golden ${candidate.scenario_id} regressed (verdict ${baseline.verdict}->${candidate.verdict}, ` +
          `ratio ${baseline.north_star_ratio.toFixed(4)}->${candidate.north_star_ratio.toFixed(4)})`,
      )
    }
  }

  // Condition 2: no new veto-gate failures, zero new FATAL.
  const newGateFailures: string[] = []
  const newFatal: string[] = []
  for (const candidate of candidateRuns) {
    const baseline = baselineByScenario.get(candidate.scenario_id)
    const baselineFailures = new Set(baseline?.failed_gate_codes ?? [])
    for (const gateCode of candidate.failed_gate_codes) {
      if (!baselineFailures.has(gateCode)) {
        newGateFailures.push(`${candidate.scenario_id}:${gateCode}`)
      }
    }
    if (candidate.fatal && !(baseline?.fatal ?? false)) {
      newFatal.push(candidate.scenario_id)
    }
  }
  if (newGateFailures.length > 0) {
    reasons.push(`new gate failures: ${newGateFailures.join(', ')}`)
  }
  if (newFatal.length > 0) {
    reasons.push(`new FATAL flags: ${newFatal.join(', ')}`)
  }

  // Condition 3: no guard (counter-metric) regression beyond tolerance.
  const guardRegressions: string[] = []
  for (const candidate of candidateRuns) {
    const baseline = baselineByScenario.get(candidate.scenario_id)
    if (baseline === undefined) {
      continue
    }
    for (const guard of guards) {
      const candidateValue = candidate.guard_metrics[guard.metric_code]
      const baselineValue = baseline.guard_metrics[guard.metric_code]
      if (candidateValue === undefined || baselineValue === undefined) {
        continue
      }
      const regressed =
        guard.direction === 'higher_better'
          ? candidateValue < baselineValue - ACCEPT_TOLERANCES.guard
          : candidateValue > baselineValue + ACCEPT_TOLERANCES.guard
      if (regressed) {
        guardRegressions.push(`${candidate.scenario_id}:${guard.metric_code}`)
      }
    }
  }
  if (guardRegressions.length > 0) {
    reasons.push(`guard regressions: ${guardRegressions.join(', ')}`)
  }

  // Condition 4: aggregate North Star improves.
  const baselineWeightedMean = weightedMeanRatio(baselineRuns)
  const candidateWeightedMean = weightedMeanRatio(candidateRuns)
  const aggregateDelta = candidateWeightedMean - baselineWeightedMean
  const aggregateImproves = aggregateDelta > ACCEPT_TOLERANCES.aggregate_improvement_epsilon
  if (!aggregateImproves) {
    reasons.push(
      `aggregate north_star did not improve (${baselineWeightedMean.toFixed(4)} -> ${candidateWeightedMean.toFixed(4)})`,
    )
  }

  const accepted =
    !corpusMismatch &&
    !goldenRegressed &&
    newGateFailures.length === 0 &&
    newFatal.length === 0 &&
    guardRegressions.length === 0 &&
    aggregateImproves

  return {
    accepted,
    corpus_mismatch: corpusMismatch,
    golden_regressed: goldenRegressed,
    new_gate_failures: newGateFailures,
    new_fatal: newFatal,
    guard_regressions: guardRegressions,
    baseline_weighted_mean: baselineWeightedMean,
    candidate_weighted_mean: candidateWeightedMean,
    aggregate_north_star_delta: aggregateDelta,
    baseline_gate_failure_rate: gateFailureRate(baselineRuns),
    candidate_gate_failure_rate: gateFailureRate(candidateRuns),
    baseline_among_passers_mean: amongPassersMean(baselineRuns),
    candidate_among_passers_mean: amongPassersMean(candidateRuns),
    reasons,
  }
}
