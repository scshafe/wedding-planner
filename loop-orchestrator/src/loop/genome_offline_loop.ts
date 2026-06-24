import {
  makePlannerSimulator,
  type GuardSpec,
  scoreCandidateOffline,
  type ScenarioDefinition,
} from '@wedding-planner/eval-harness'
import { ManualClock, type OversightRecord, SequentialIdGenerator } from '@wedding-planner/shared'
import { type MetricEngine } from '@wedding-planner/telemetry'

import { type ChampionStore } from '../genome/champion_store'
import { type GenomeRegistry } from '../genome/genome_registry'
import { type Ledger } from '../ledger/ledger'
import { LoopOrchestratorError } from '../loop_orchestrator_error'
import { ApprovalStore } from '../pipeline/landing_approval'
import { runPromotionGate } from '../pipeline/promotion_gate'
import { reconcileCandidateRiskTier } from '../pipeline/risk_tier_reconciliation'
import { type Proposer } from '../proposer/proposer'
import { type OfflineLoopSummary, runOfflineLoop } from './offline_loop'

/**
 * @canonical genome_offline_loop -- the Phase-2 wiring that makes the offline loop a REAL optimizer.
 *
 * It assembles the pieces the generic runOfflineLoop leaves injectable, closing the candidate-blind
 * gap: each iteration scores the candidate's genome against the CURRENT CHAMPION via the two-stage
 * planner simulator, runs the risk-tier reconciliation as the pre-score firewall gate, and on accept
 * PROMOTES the champion (the ratchet) and records the genome lineage in the ledger. The champion the
 * scorer reads is re-read every call, so an accepted candidate becomes the next baseline (hill-climb).
 *
 * related: loop/offline_loop.ts (the generic engine), genome/champion_store.ts, eval-harness simulator.
 */
export interface GenomeOfflineLoopConfig {
  readonly proposer: Proposer
  readonly championStore: ChampionStore
  readonly registry: GenomeRegistry
  readonly corpus: readonly ScenarioDefinition[]
  /** Hard guards (counter-metrics that may not regress). The cadence tradeoff lives in the North Star, not here. */
  readonly guards: readonly GuardSpec[]
  readonly metricEngine: MetricEngine
  readonly harnessVersion: string
  /** Injected determinism: the instant each simulator run + scoring pass starts at. */
  readonly baseTimestamp: string
  readonly ledger: Ledger
  readonly clock: ManualClock
  readonly ids: SequentialIdGenerator
  readonly maxDryIterations: number
  readonly maxIterations?: number
  /**
   * Exogenous human approvals for tier-2 landings (Phase 4a). Read-only input: the loop NEVER mints an
   * approval. Omitted (the autonomous default) => the approval store is empty => every accepted tier-2
   * candidate parks. Supply approvals only from a channel outside the loop (a human, a future gate).
   */
  readonly approvals?: readonly OversightRecord[]
}

export function runGenomeOfflineLoop(config: GenomeOfflineLoopConfig): OfflineLoopSummary {
  // Build the read-only approval channel ONCE so markSpent (one-shot) persists across iterations. The
  // loop constructs only a *reader* over injected records — it has no method that authors an approval.
  const approvals = new ApprovalStore(config.approvals)
  return runOfflineLoop({
    proposer: config.proposer,
    ledger: config.ledger,
    clock: config.clock,
    ids: config.ids,
    maxDryIterations: config.maxDryIterations,
    ...(config.maxIterations === undefined ? {} : { maxIterations: config.maxIterations }),

    // The fitness function: score the candidate genome against the CURRENT champion.
    scoreCandidate: (candidate) => {
      const candidateGenome = config.registry.resolve(candidate.change.artifact_ref)
      if (candidateGenome === undefined) {
        // Unreachable: the pre-score gate (reconciliation) already resolved + verified the ref.
        throw new LoopOrchestratorError(
          'GENOME_LOOP.UNRESOLVED_CANDIDATE_GENOME',
          `Candidate ${candidate.candidate_id} reached scoring with an unresolved artifact_ref.`,
          { context: { candidate_id: candidate.candidate_id } },
        )
      }
      const runner = makePlannerSimulator({
        championGenome: config.championStore.current(),
        candidateGenome,
        candidateArtifactRef: candidate.change.artifact_ref,
        baseTimestamp: config.baseTimestamp,
      })
      return scoreCandidateOffline({
        corpus: config.corpus,
        runner,
        guards: config.guards,
        metricEngine: config.metricEngine,
        clock: new ManualClock(config.baseTimestamp),
        ids: new SequentialIdGenerator(`score_${candidate.candidate_id}`),
        harnessVersion: config.harnessVersion,
      })
    },

    // The pre-score firewall gate: re-derive the tier from the content-addressed genome.
    preScoreGate: (candidate) => {
      const reconciliation = reconcileCandidateRiskTier(candidate, config.registry)
      return reconciliation.ok ? { ok: true } : { ok: false, detail: reconciliation.detail }
    },

    // The tier gate (Phase 4a): re-derive the tier from the content-addressed genome and decide whether
    // the accepted candidate LANDS (tier <= 1, ratchet the champion), PARKS (tier 2+ with no exogenous
    // approval), or is human-rejected. The gate writes the promote/park/reject ledger transitions and
    // returns the outcome the generic loop accounts for.
    onAccepted: (candidate) =>
      runPromotionGate({
        candidate,
        registry: config.registry,
        championStore: config.championStore,
        ledger: config.ledger,
        approvals,
      }),
  })
}
