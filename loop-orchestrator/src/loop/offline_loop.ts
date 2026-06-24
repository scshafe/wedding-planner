import { type OfflineScoreResult, type PerScenarioScore } from '@wedding-planner/eval-harness'
import type { CandidateChange, Clock, IdGenerator } from '@wedding-planner/shared'

import { type Ledger } from '../ledger/ledger'
import { DECIDED_BY, STAGES } from '../loop_orchestrator_constants'
import { runOfflineSelection } from '../pipeline/deterministic_selector'
import { type Proposer } from '../proposer/proposer'

/**
 * @canonical offline_loop -- the fast offline clock: a continuous propose -> score -> ledger -> learn
 * loop (loop_architecture.md "Convergence", README "Two clocks"). It targets the weakest capability
 * and uses LOOP-UNTIL-DRY termination: after K consecutive iterations with no offline_passed
 * candidate, the search is "dry" and the loop stops.
 *
 * Phase 1 stops when dry. The full design then shifts to corpus-hardening mode (mine production for
 * new hard cases to un-dry the search) — deferred, since the offline core has no production yet.
 *
 * The model authors only the proposal; the deterministic selector decides every advance and the
 * ledger is the durable memory whose `lessons` feed the next proposal (the "learn" edge).
 *
 * related: proposer/proposer.ts, pipeline/deterministic_selector.ts, ledger/ledger.ts.
 */

export interface OfflineLoopConfig {
  readonly proposer: Proposer
  /** Score a candidate across the corpus (wraps eval-harness scoreCandidateOffline). */
  readonly scoreCandidate: (candidate: CandidateChange) => OfflineScoreResult
  readonly ledger: Ledger
  readonly clock: Clock
  readonly ids: IdGenerator
  /** K: consecutive non-passing iterations before the search is declared dry. */
  readonly maxDryIterations: number
  /** Hard cap on iterations (the compute/token budget bound); optional. */
  readonly maxIterations?: number
}

export type LoopTerminationReason = 'dry' | 'budget_exhausted' | 'proposer_exhausted'

export interface OfflineLoopSummary {
  readonly iterations: number
  readonly proposed: number
  readonly accepted: number
  readonly rejected: number
  readonly terminatedReason: LoopTerminationReason
  readonly acceptedCandidateIds: readonly string[]
}

/** The weakest capability across a set of per-scenario scores (lowest scorecard entry), or null. */
function weakestCapabilityOf(scores: readonly PerScenarioScore[]): string | null {
  let weakest: string | null = null
  let minScore = Number.POSITIVE_INFINITY
  for (const score of scores) {
    for (const entry of score.grade_report.data?.per_capability_scorecard ?? []) {
      if (entry.score < minScore) {
        minScore = entry.score
        weakest = entry.capability
      }
    }
  }
  return weakest
}

export function runOfflineLoop(config: OfflineLoopConfig): OfflineLoopSummary {
  const acceptedCandidateIds: string[] = []
  const lessons: string[] = []
  let iterations = 0
  let proposed = 0
  let accepted = 0
  let rejected = 0
  let consecutiveDry = 0
  let weakestCapability: string | null = null

  const summary = (terminatedReason: LoopTerminationReason): OfflineLoopSummary => ({
    iterations,
    proposed,
    accepted,
    rejected,
    terminatedReason,
    acceptedCandidateIds,
  })

  for (;;) {
    if (consecutiveDry >= config.maxDryIterations) {
      return summary('dry')
    }
    if (config.maxIterations !== undefined && iterations >= config.maxIterations) {
      return summary('budget_exhausted')
    }

    const candidate = config.proposer.propose({ iteration: iterations, weakestCapability, lessons })
    if (candidate === null) {
      return summary('proposer_exhausted')
    }
    proposed += 1

    // The proposer authored proposed -> implemented (the one ai_proposer edge).
    config.ledger.append({
      candidate_id: candidate.candidate_id,
      from_state: STAGES.proposed,
      to_state: STAGES.implemented,
      decided_by: DECIDED_BY.ai_proposer,
      rationale: candidate.hypothesis.rationale,
    })

    const scoreResult = config.scoreCandidate(candidate)
    const selection = runOfflineSelection(candidate, scoreResult, config.ledger)
    iterations += 1
    weakestCapability = weakestCapabilityOf(scoreResult.candidate)

    if (selection.accepted) {
      accepted += 1
      acceptedCandidateIds.push(candidate.candidate_id)
      consecutiveDry = 0 // progress un-dries the search
    } else {
      rejected += 1
      consecutiveDry += 1
      // Learn: the ledger's lessons for this candidate feed the next proposal.
      const entry = config.ledger.getEntry(candidate.candidate_id)
      lessons.push(...(entry?.lessons ?? []))
    }
  }
}
