import {
  type GuardSpec,
  makePlannerSimulator,
  type Planner,
  type ScenarioDefinition,
  scoreCandidateOffline,
} from '@wedding-planner/eval-harness'
import {
  ManualClock,
  type StrategyGenome,
  SequentialIdGenerator,
} from '@wedding-planner/shared'
import { type MetricEngine } from '@wedding-planner/telemetry'

import { type ChampionStore } from '../genome/champion_store'
import { type GenomeRegistry } from '../genome/genome_registry'
import { type Ledger } from '../ledger/ledger'
import { LoopOrchestratorError } from '../loop_orchestrator_error'
import { ApprovalStore, landingKeyFor } from '../pipeline/landing_approval'
import { runPromotionGate } from '../pipeline/promotion_gate'
import { reconcileCandidateRiskTier } from '../pipeline/risk_tier_reconciliation'
import { type AdvisoryProposer } from '../proposer/advisory_proposer'
import { type OfflineLoopSummary, runOfflineLoop } from './offline_loop'

/**
 * @canonical advisory_loop -- the Phase-11 ADVISORY pass: it EXPLORES tier-2 candidates over a
 * plan-side corpus and surfaces the firewall-clean, accept-rule-passing ones as ranked PROMOTABLE
 * recommendations — without ever landing them.
 *
 * WHY: the plan-side value built across Phases 7-10 (quality 0.40, completeness, qa, vision) is dormant
 * — the auto-landing search optimizes only the tier-1 reminder box and never emits a tier-2 genome, so
 * consulting-the-couple value never reaches any output. Tier-2 may not auto-land (the safety rail). The
 * honest move is to explore tier-2 and SURFACE the best as "promotable, pending human approval"
 * recommendations. A human (the exogenous approval channel) decides whether any land.
 *
 * HOW (reuse, do not fork — the firewall path is identical to the auto-landing loop):
 *  - it runs the SAME generic engine (runOfflineLoop) with the SAME scorer + veto gates + integrity
 *    reconciliation (scoreCandidateOffline) and the SAME promotion gate (runPromotionGate);
 *  - it injects the AdvisoryProposer (tier-2 only), a plan-side corpus, and an EMPTY ApprovalStore, so
 *    every accepted tier-2 candidate PARKS (promotion_gate.ts: tier 2 + no approval => parkCandidate).
 *    The parked set IS the recommendation set;
 *  - a forged/dishonest candidate (claims a vision_match it cannot earn, or shaves a vision_consult
 *    cost) is VETOED by the integrity gate, fails the accept rule, and never reaches the park — so it is
 *    EXCLUDED from the recommendation set. A human only ever sees honest, trusted-backed recommendations.
 *
 * SAFETY (doddy P1-A / P1-C): the caller MUST pass ISOLATED champion/registry/ledger instances (never
 * the auto-landing loop's references). This pass never ratchets the champion (every accept parks) and
 * never mints an approval (the ApprovalStore is constructed empty here, not from caller input). The
 * recommendation records are tagged `provenance: 'advisory'` so no reader mistakes an advisory
 * recommendation for a real auto-loop park awaiting approval (doddy P2-A).
 *
 * CERTIFICATE (architect P1): `frontierFullyExplored` is true iff the proposer CONVERGED (every autonomy
 * level explored against the frozen champion) AND every accept parked (none promoted / human-rejected).
 * The generic `converged` enum is NOT overloaded; the advisory meaning lives here. `maxDryIterations` is
 * forced to `boxSize + 1` so the dry cap cannot trip before the frontier is fully explored and certified.
 *
 * related: proposer/advisory_proposer.ts, loop/genome_offline_loop.ts (the auto-landing sibling),
 * pipeline/promotion_gate.ts, pipeline/landing_approval.ts (landingKeyFor).
 */

export interface AdvisoryLoopConfig {
  /** The tier-2 exploration proposer. Its `boxSize` sets the (safe) dry cap. */
  readonly proposer: AdvisoryProposer
  /** ISOLATED champion store seeded with the tier-1 base genome the recommendations are measured against. */
  readonly championStore: ChampionStore
  /** ISOLATED genome registry — never the auto-landing loop's, so advisory genomes stay unresolvable there. */
  readonly registry: GenomeRegistry
  /** ISOLATED, throwaway ledger — never the production audit trail. */
  readonly ledger: Ledger
  /** The plan-side advisory corpus (vision-sensitive scenarios). NEVER the tier-1 search corpus. */
  readonly corpus: readonly ScenarioDefinition[]
  /**
   * The advisory guard set. Positive rule (architect P2): all VALUE metrics present in the corpus, MINUS
   * `couple_active_minutes_total` (the consult cost is already priced into the North-Star denominator —
   * guarding it double-counts and would reject every tier-2 candidate). Guarding the value metrics closes
   * the cross-value-regression hole (a candidate buying vision by tanking rsvp).
   */
  readonly guards: readonly GuardSpec[]
  readonly metricEngine: MetricEngine
  readonly harnessVersion: string
  readonly baseTimestamp: string
  readonly clock: ManualClock
  readonly ids: SequentialIdGenerator
  /**
   * Optional planner override (defaults to the honest simulator planner). It does NOT weaken the
   * firewall — the integrity gate reconciles the planner's CLAIMS against the trusted record regardless,
   * so a dishonest planner's forged/suppressed claims are vetoed and excluded from the recommendation
   * set. The keystone uses this seam to prove that exclusion through the real runAdvisoryLoop path.
   */
  readonly planner?: Planner
}

/**
 * One promotable recommendation: a tier-2 genome that, on the advisory corpus, passed the firewall AND
 * the accept rule against the frozen advisory champion (so it would PARK pending human approval). It
 * carries the (genome, champion) pair the human reviews and the landing key an approval must bind to.
 */
export interface PromotableRecommendation {
  readonly candidate_id: string
  /** The tier-2 genome a human would be asked to approve for landing. */
  readonly genome: StrategyGenome
  /** The frozen tier-1 base the recommendation is measured against (the landing key binds to it). */
  readonly advisory_champion: StrategyGenome
  /** `landingKeyFor(genome, advisory_champion)` — the content-address an exogenous approval must bind to. */
  readonly landing_key: string
  /** Aggregate North-Star improvement vs the advisory champion on the corpus (the ranking key). */
  readonly north_star_delta: number
  /** Provenance tag so a reader never confuses this with a real auto-loop park awaiting approval. */
  readonly provenance: 'advisory'
}

export interface AdvisoryLoopResult {
  /** The promotable recommendations, ranked by `north_star_delta` descending. */
  readonly recommendations: readonly PromotableRecommendation[]
  /**
   * True iff the tier-2 frontier was fully explored (proposer converged) AND every accept parked (none
   * landed) — the advisory certificate. False means the dry/budget cap truncated exploration.
   */
  readonly frontierFullyExplored: boolean
  /** The underlying loop summary (counts), for diagnostics. */
  readonly summary: OfflineLoopSummary
}

export function runAdvisoryLoop(config: AdvisoryLoopConfig): AdvisoryLoopResult {
  // The advisory champion is FROZEN: every accept parks, so it never ratchets. Capture it once for the
  // landing keys (current() always returns the seed throughout this pass).
  const advisoryChampion = config.championStore.current()

  // The ApprovalStore is constructed EMPTY here — never from caller input. With no approval, every
  // tier-2 candidate parks (the safe outcome). This is the structural "the advisory pass cannot land".
  const approvals = new ApprovalStore([])

  // Capture each proposed candidate's score so the parked ones can be ranked by North-Star delta. The
  // delta is the accept rule's own aggregate_north_star_delta — no re-scoring, no second code path.
  const scored = new Map<string, { genome: StrategyGenome; delta: number }>()

  // Force the dry cap above the frontier so exploration cannot be truncated before it is certified
  // (architect P1): all boxSize tier-2 candidates park (consecutiveDry climbs to boxSize), then one more
  // iteration must reach the converged certificate — so the cap must exceed boxSize.
  const maxDryIterations = config.proposer.boxSize + 1

  const summary = runOfflineLoop({
    proposer: config.proposer,
    ledger: config.ledger,
    clock: config.clock,
    ids: config.ids,
    maxDryIterations,

    scoreCandidate: (candidate) => {
      const candidateGenome = config.registry.resolve(candidate.change.artifact_ref)
      if (candidateGenome === undefined) {
        throw new LoopOrchestratorError(
          'GENOME_LOOP.UNRESOLVED_CANDIDATE_GENOME',
          `Advisory candidate ${candidate.candidate_id} reached scoring with an unresolved artifact_ref.`,
          { context: { candidate_id: candidate.candidate_id } },
        )
      }
      const runner = makePlannerSimulator({
        championGenome: config.championStore.current(),
        candidateGenome,
        candidateArtifactRef: candidate.change.artifact_ref,
        baseTimestamp: config.baseTimestamp,
        ...(config.planner === undefined ? {} : { planner: config.planner }),
      })
      const result = scoreCandidateOffline({
        corpus: config.corpus,
        runner,
        guards: config.guards,
        metricEngine: config.metricEngine,
        clock: new ManualClock(config.baseTimestamp),
        ids: new SequentialIdGenerator(`advisory_score_${candidate.candidate_id}`),
        harnessVersion: config.harnessVersion,
      })
      scored.set(candidate.candidate_id, {
        genome: candidateGenome,
        delta: result.decision.aggregate_north_star_delta,
      })
      return result
    },

    // Same pre-score firewall as the auto-landing loop: a candidate whose declared tier is forged down
    // is rejected before scoring (an honest AdvisoryProposer candidate declares tier 2 and passes).
    preScoreGate: (candidate) => {
      const reconciliation = reconcileCandidateRiskTier(candidate, config.registry)
      return reconciliation.ok ? { ok: true } : { ok: false, detail: reconciliation.detail }
    },

    // Same promotion gate — but with an EMPTY approval store, so every tier-2 accept PARKS. The parked
    // candidates are the recommendation set; the champion never ratchets.
    onAccepted: (candidate) =>
      runPromotionGate({
        candidate,
        registry: config.registry,
        championStore: config.championStore,
        ledger: config.ledger,
        approvals,
        // Self-identify the park (doddy P2): even read outside its isolated ledger, an advisory park can
        // never be mistaken for a real auto-loop park awaiting approval.
        parkProvenanceNote: 'advisory exploration — never entered the auto-loop',
      }),
  })

  // Build the recommendation set from the PARKED candidates only (firewall + accept rule already passed).
  const recommendations: PromotableRecommendation[] = []
  for (const candidateId of summary.parkedCandidateIds) {
    const entry = scored.get(candidateId)
    if (entry === undefined) continue // a parked candidate is always scored; defensive skip
    recommendations.push({
      candidate_id: candidateId,
      genome: entry.genome,
      advisory_champion: advisoryChampion,
      landing_key: landingKeyFor(entry.genome, advisoryChampion),
      north_star_delta: entry.delta,
      provenance: 'advisory',
    })
  }
  recommendations.sort((a, b) => b.north_star_delta - a.north_star_delta)

  const frontierFullyExplored =
    summary.terminatedReason === 'converged' &&
    summary.promoted === 0 &&
    summary.humanRejected === 0 &&
    summary.parked === summary.accepted

  return { recommendations, frontierFullyExplored, summary }
}
