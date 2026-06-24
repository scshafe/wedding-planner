import { type OfflineScoreResult, type PerScenarioScore } from '@wedding-planner/eval-harness'
import type { CandidateChange, Clock, IdGenerator } from '@wedding-planner/shared'

import { type Ledger } from '../ledger/ledger'
import { DECIDED_BY, FINAL_DISPOSITIONS, STAGES } from '../loop_orchestrator_constants'
import { runOfflineSelection } from '../pipeline/deterministic_selector'
import { type Proposer } from '../proposer/proposer'

/**
 * A pre-score gate verdict (Phase 2: the risk-tier reconciliation). `ok: false` rejects the candidate
 * BEFORE scoring — a firewall rejection, not a fitness one. Kept structural so the generic loop does
 * not depend on the reconciliation module.
 */
export interface PreScoreGateVerdict {
  readonly ok: boolean
  readonly detail?: string
}

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
  /**
   * Optional pre-score firewall gate (Phase 2: risk-tier reconciliation). Runs after the candidate is
   * implemented and BEFORE scoring; `ok: false` writes a risk_tier_gate rejection and skips scoring —
   * a candidate that fails the firewall is never even fitness-evaluated.
   */
  readonly preScoreGate?: (candidate: CandidateChange) => PreScoreGateVerdict
  /**
   * Optional hook fired after a candidate PASSES the offline accept rule. It owns the PROMOTION
   * decision and returns the outcome (Phase 4a: the tier-2 gate):
   *  - `promoted`      — the candidate landed (the champion ratcheted). Real progress: un-dries the loop.
   *  - `parked`        — accepted-by-rule but WITHHELD (a tier-2 candidate with no exogenous human
   *                      approval). The champion did NOT ratchet, so this is NOT champion progress.
   *  - `human_rejected`— accepted-by-rule but the human gate returned `approved:false`. Terminal.
   * A hook that returns `void`/undefined is treated as `promoted` (the generic, gate-free engine: an
   * accept lands). The hook — not the generic loop — re-derives the tier and writes the gate's ledger
   * transitions; the loop only interprets the outcome for its accounting and termination.
   */
  readonly onAccepted?: (candidate: CandidateChange) => PromotionOutcome | void
}

/**
 * The outcome of the post-accept promotion gate (Phase 4a). An accepted candidate either LANDS
 * (`promoted` — the champion ratchets), is WITHHELD pending an exogenous human approval (`parked` —
 * the autonomous loop may never self-grant tier-2 autonomy, so a tier-2 accept with no injected
 * approval parks), or is rejected at the human gate (`human_rejected`). Only `promoted` advances the
 * champion; `parked`/`human_rejected` make no champion progress (they do NOT reset the dry counter).
 */
export type PromotionOutcome = 'promoted' | 'parked' | 'human_rejected'

/**
 * Why the loop stopped (Phase-3 termination taxonomy):
 *  - `converged`          — the proposer reported its bounded search space is EXHAUSTED against the
 *                           standing champion with nothing accepted: a "no point is acceptable against
 *                           the standing champion" certificate (NOT a global-optimum claim — guards or
 *                           golden conditions can veto a higher-North-Star point). Only a proposer that
 *                           implements `isConverged()` (the box search) can yield this.
 *  - `proposer_exhausted` — the proposer returned null WITHOUT a convergence certificate (it simply ran
 *                           out — e.g. a finite generator with no completeness claim).
 *  - `budget_exhausted`   — `maxIterations` was hit first: no certificate, the champion is a best-so-far.
 *  - `dry`                — `maxDryIterations` consecutive non-accepts before the search was exhausted:
 *                           STALLED, not certified (run with maxDryIterations >= the search size to let
 *                           a convergence certificate emerge instead).
 *
 * Termination is guaranteed: every accept requires a STRICT aggregate-North-Star improvement (accept
 * condition 4), so the champion's North Star strictly increases on each promotion. Over a finite,
 * content-addressed genome space that bounds the number of promotions (no champion can recur), and the
 * proposer never re-proposes a (champion, genome) pair — so even with binding guards (which can reject
 * but never make accept non-monotone in North Star) the loop cannot cycle.
 */
export type LoopTerminationReason = 'converged' | 'dry' | 'budget_exhausted' | 'proposer_exhausted'

export interface OfflineLoopSummary {
  readonly iterations: number
  readonly proposed: number
  /** Candidates that PASSED the offline accept rule (= promoted + parked + humanRejected). */
  readonly accepted: number
  readonly rejected: number
  readonly terminatedReason: LoopTerminationReason
  readonly acceptedCandidateIds: readonly string[]
  /** Of the accepted: those that LANDED (champion ratcheted). The tier-1 / approved-tier-2 path. */
  readonly promoted: number
  /** Of the accepted: those WITHHELD pending an exogenous human approval (tier-2, no approval). */
  readonly parked: number
  readonly parkedCandidateIds: readonly string[]
  /** Of the accepted: those the human gate rejected (`approved:false`). Terminal, not parked-for-retry. */
  readonly humanRejected: number
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
  const parkedCandidateIds: string[] = []
  const lessons: string[] = []
  let iterations = 0
  let proposed = 0
  let accepted = 0
  let rejected = 0
  let promoted = 0
  let parked = 0
  let humanRejected = 0
  let consecutiveDry = 0
  let weakestCapability: string | null = null

  const summary = (terminatedReason: LoopTerminationReason): OfflineLoopSummary => ({
    iterations,
    proposed,
    accepted,
    rejected,
    terminatedReason,
    acceptedCandidateIds,
    promoted,
    parked,
    parkedCandidateIds,
    humanRejected,
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
      // A proposer that exhausts a bounded space against the standing champion CONVERGED; one that
      // merely ran out did not. We reach here only with both caps un-tripped, so the certificate is
      // genuine (the loop checks maxDry / maxIterations BEFORE proposing).
      return summary(config.proposer.isConverged?.() ? 'converged' : 'proposer_exhausted')
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

    // Pre-score firewall gate (Phase 2): a candidate that fails the risk-tier reconciliation is
    // rejected here, BEFORE any fitness scoring — the firewall comes before the optimizer.
    const gate = config.preScoreGate?.(candidate)
    if (gate !== undefined && !gate.ok) {
      const detail = gate.detail ?? 'risk-tier reconciliation failed'
      config.ledger.append({
        candidate_id: candidate.candidate_id,
        from_state: STAGES.implemented,
        to_state: STAGES.offline_rejected,
        decided_by: DECIDED_BY.risk_tier_gate,
        rationale: detail,
        evidence_ref: candidate.change.artifact_ref,
      })
      config.ledger.setFinalDisposition(candidate.candidate_id, FINAL_DISPOSITIONS.rejected_offline)
      config.ledger.addLesson(candidate.candidate_id, `risk_tier_gate: ${detail}`)
      iterations += 1
      rejected += 1
      consecutiveDry += 1
      lessons.push(...(config.ledger.getEntry(candidate.candidate_id)?.lessons ?? []))
      continue
    }

    const scoreResult = config.scoreCandidate(candidate)
    const selection = runOfflineSelection(candidate, scoreResult, config.ledger)
    iterations += 1
    weakestCapability = weakestCapabilityOf(scoreResult.candidate)

    if (selection.accepted) {
      accepted += 1
      acceptedCandidateIds.push(candidate.candidate_id)
      // The gate (Phase 4a) owns the promote/park/reject decision; a void hook means "promote" (the
      // gate-free engine). Only a landed PROMOTION is champion progress that un-dries the search — a
      // parked or human-rejected accept ratchets nothing, so it must NOT reset the dry counter (else a
      // stream of un-landable tier-2 accepts could mask convergence).
      const outcome = config.onAccepted?.(candidate) ?? 'promoted'
      if (outcome === 'promoted') {
        promoted += 1
        consecutiveDry = 0
      } else if (outcome === 'parked') {
        parked += 1
        parkedCandidateIds.push(candidate.candidate_id)
        consecutiveDry += 1
      } else {
        humanRejected += 1
        consecutiveDry += 1
      }
    } else {
      rejected += 1
      consecutiveDry += 1
      // Learn: the ledger's lessons for this candidate feed the next proposal.
      const entry = config.ledger.getEntry(candidate.candidate_id)
      lessons.push(...(entry?.lessons ?? []))
    }
  }
}
