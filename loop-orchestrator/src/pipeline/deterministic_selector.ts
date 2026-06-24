import { AGGREGATION_WEIGHTS, type OfflineScoreResult, type PerScenarioScore } from '@wedding-planner/eval-harness'
import type { CandidateChange, LedgerEntry } from '@wedding-planner/shared'

import { type Ledger, type OfflineResult } from '../ledger/ledger'
import { DECIDED_BY, FINAL_DISPOSITIONS, STAGES } from '../loop_orchestrator_constants'

/**
 * @canonical deterministic_selector -- drives a candidate through the OFFLINE stage machine and
 * writes the ledger (loop_architecture.md). It consumes the eval-harness offline score (the fitness
 * function's verdict) and is the mechanism — NOT the proposer — that advances the candidate:
 * implemented -> offline_scoring -> offline_passed | offline_rejected, every transition
 * decided_by: deterministic_selector.
 *
 * It also runs the surprise check (loop_architecture.md): a candidate that improves the aggregate
 * while its DECLARED mechanism did not fire (low hypothesis confirmation / low attribution share) is
 * the signature of corpus gaming. Phase 1 records the surprise fields in the ledger's offline_result;
 * routing-to-human on a surprise is a later-phase concern (no human path in the offline core).
 *
 * related: ledger.ts, eval-harness offline_scorer.ts.
 */

export interface SurpriseCheck {
  readonly hypothesis_confirmed: boolean
  readonly observed_target_delta: number | null
  readonly target_attribution_share: number | null
}

function aggregationWeight(type: PerScenarioScore['scenario_type']): number {
  return type === 'golden' ? AGGREGATION_WEIGHTS.golden : AGGREGATION_WEIGHTS.adversarial
}

function pairByScenario(
  candidate: readonly PerScenarioScore[],
  baseline: readonly PerScenarioScore[],
): Array<{ candidate: PerScenarioScore; baseline: PerScenarioScore }> {
  const baselineById = new Map(baseline.map((score) => [score.scenario_id, score] as const))
  const pairs: Array<{ candidate: PerScenarioScore; baseline: PerScenarioScore }> = []
  for (const candidateScore of candidate) {
    const baselineScore = baselineById.get(candidateScore.scenario_id)
    if (baselineScore !== undefined) {
      pairs.push({ candidate: candidateScore, baseline: baselineScore })
    }
  }
  return pairs
}

/**
 * The surprise check: did the target_metric move the predicted direction on the target scenarios,
 * and how much of the aggregate North Star gain is attributable to them. An aggregate gain with the
 * declared mechanism NOT firing (or attribution near zero) is the corpus-gaming signature.
 */
export function computeSurpriseCheck(
  hypothesis: CandidateChange['hypothesis'],
  scoreResult: OfflineScoreResult,
): SurpriseCheck {
  const pairs = pairByScenario(scoreResult.candidate, scoreResult.baseline)
  const targetScenarioIds = new Set(
    hypothesis.target_scenario_ids ?? pairs.map((pair) => pair.candidate.scenario_id),
  )
  const targetPairs = pairs.filter((pair) => targetScenarioIds.has(pair.candidate.scenario_id))

  // observed_target_delta: mean change in the target metric across the target scenarios.
  const targetDeltas = targetPairs
    .map((pair) => {
      const candidateValue = pair.candidate.metric_values[hypothesis.target_metric_code]
      const baselineValue = pair.baseline.metric_values[hypothesis.target_metric_code]
      if (candidateValue === undefined || candidateValue === null || baselineValue === undefined || baselineValue === null) {
        return null
      }
      return candidateValue - baselineValue
    })
    .filter((delta): delta is number => delta !== null)
  const observedTargetDelta =
    targetDeltas.length === 0
      ? null
      : targetDeltas.reduce((sum, delta) => sum + delta, 0) / targetDeltas.length

  const hypothesisConfirmed =
    observedTargetDelta !== null &&
    (hypothesis.expected_direction === 'increase' ? observedTargetDelta > 0 : observedTargetDelta < 0)

  // target_attribution_share: fraction of the total weighted ratio gain coming from target scenarios.
  const weightedGain = (subset: typeof pairs): number =>
    subset.reduce((sum, pair) => {
      const weight = aggregationWeight(pair.candidate.scenario_type)
      return sum + weight * (pair.candidate.scenario_run_result.north_star_ratio - pair.baseline.scenario_run_result.north_star_ratio)
    }, 0)
  const totalGain = weightedGain(pairs)
  const targetGain = weightedGain(targetPairs)
  const targetAttributionShare = totalGain <= 0 ? 0 : Math.max(0, Math.min(1, targetGain / totalGain))

  return {
    hypothesis_confirmed: hypothesisConfirmed,
    observed_target_delta: observedTargetDelta,
    target_attribution_share: targetAttributionShare,
  }
}

export interface OfflineSelectionResult {
  readonly accepted: boolean
  readonly ledgerEntry: LedgerEntry
  readonly offlineResult: OfflineResult
}

/**
 * Drive one candidate through offline selection, writing the ledger. The candidate must already be
 * at `implemented` (the proposer authored proposed -> implemented). Idempotent via the ledger.
 */
export function runOfflineSelection(
  candidate: CandidateChange,
  scoreResult: OfflineScoreResult,
  ledger: Ledger,
): OfflineSelectionResult {
  const candidateId = candidate.candidate_id
  const gradeReportRefs = scoreResult.candidate.map((score) => score.run_id)
  const evidenceRef = gradeReportRefs[0] ?? null

  ledger.append({
    candidate_id: candidateId,
    from_state: STAGES.implemented,
    to_state: STAGES.offline_scoring,
    decided_by: DECIDED_BY.deterministic_selector,
    rationale: 'scoring candidate across the corpus',
  })

  const decision = scoreResult.decision
  const surprise = computeSurpriseCheck(candidate.hypothesis, scoreResult)
  const offlineResult: OfflineResult = {
    aggregate_north_star_delta: decision.aggregate_north_star_delta,
    golden_regressed: decision.golden_regressed,
    new_gate_failures: [...decision.new_gate_failures],
    guard_regressions: [...decision.guard_regressions],
    hypothesis_confirmed: surprise.hypothesis_confirmed,
    observed_target_delta: surprise.observed_target_delta,
    target_attribution_share: surprise.target_attribution_share,
    grade_report_refs: gradeReportRefs,
  }
  ledger.setOfflineResult(candidateId, offlineResult)

  if (decision.accepted) {
    ledger.append({
      candidate_id: candidateId,
      from_state: STAGES.offline_scoring,
      to_state: STAGES.offline_passed,
      decided_by: DECIDED_BY.deterministic_selector,
      rationale: 'passed all four accept-rule conditions',
      evidence_ref: evidenceRef,
    })
  } else {
    ledger.append({
      candidate_id: candidateId,
      from_state: STAGES.offline_scoring,
      to_state: STAGES.offline_rejected,
      decided_by: DECIDED_BY.deterministic_selector,
      rationale: decision.reasons.join('; ') || 'did not satisfy the accept rule',
      evidence_ref: evidenceRef,
    })
    ledger.setFinalDisposition(candidateId, FINAL_DISPOSITIONS.rejected_offline)
    ledger.addLesson(candidateId, `offline_rejected: ${decision.reasons.join('; ')}`)
  }

  return {
    accepted: decision.accepted,
    ledgerEntry: ledger.getValidatedEntry(candidateId),
    offlineResult,
  }
}
