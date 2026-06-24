import { type CandidateChange, deriveRiskTier, type StrategyGenome } from '@wedding-planner/shared'

import { type ChampionStore } from '../genome/champion_store'
import { type GenomeRegistry } from '../genome/genome_registry'
import { type Ledger } from '../ledger/ledger'
import { type PromotionOutcome } from '../loop/offline_loop'
import { type DecidedBy, DECIDED_BY, FINAL_DISPOSITIONS, STAGES } from '../loop_orchestrator_constants'
import { LoopOrchestratorError } from '../loop_orchestrator_error'

/**
 * @canonical promotion_gate -- the post-accept tier gate that decides whether an accepted candidate
 * LANDS, is WITHHELD pending human approval, or is rejected at the human gate (Phase 4a).
 *
 * This is what makes the firewall's tier-2 human-gate LOAD-BEARING. Before this gate, the loop's only
 * promotion seam was unconditional: any candidate that passed the offline accept rule auto-ratcheted
 * the champion. A tier-2 genome (one touching the commitment_autonomy surface — the AI deciding to act
 * on the couple's behalf without asking) that honestly declared tier 2 sailed through and promoted
 * itself, i.e. the autonomous loop granted ITSELF tier-2 autonomy. That is the exact rail breach the
 * safety model forbids (a Tier-2 action requires human approval before it lands).
 *
 * The gate closes it with two load-bearing properties:
 *  - DERIVED-TIER AT THE SEAM (doddy): the promote/park discriminator re-resolves the genome from its
 *    content-addressed artifact_ref and re-derives the tier with `deriveRiskTier` HERE — it never reads
 *    the candidate's self-declared `risk_tier`. So even if the pre-score under-declaration gate were
 *    bypassed, a candidate whose declared tier was forged down to 1 over a tier-2 genome still parks.
 *  - AUTONOMOUS AUTHORITY IS BOUNDED AT TIER 1: tier <= MAX_AUTONOMOUS_PROMOTION_TIER auto-promotes;
 *    anything higher routes to human_review and may land ONLY with an exogenous approval (Phase 4a
 *    Step 3 adds the approval lookup; with none, the candidate parks). The loop has no method that
 *    mints an approval, so in real autonomous operation every tier-2 candidate parks — which is safe.
 *
 * Every decision is a tamper-evident ledger transition (promote / park / reject), so the audit trail
 * shows "accepted offline, tier-N, <landed|parked|rejected>" rather than a silent ratchet.
 *
 * related: shared/strategy/risk_tier.ts (deriveRiskTier), pipeline/risk_tier_reconciliation.ts (the
 * pre-score sibling), genome/champion_store.ts, ledger/ledger.ts.
 */

/**
 * The highest tier the autonomous loop may LAND (auto-promote) without an exogenous human approval.
 * Tier 0 (cosmetic) and tier 1 (planning-flow orchestration) are the autonomously-optimizable box;
 * tier 2+ (commitment autonomy, guest comms, bindings, PII, spend, graders) require the human gate.
 */
export const MAX_AUTONOMOUS_PROMOTION_TIER = 1

export interface PromotionGateConfig {
  readonly candidate: CandidateChange
  readonly registry: GenomeRegistry
  readonly championStore: ChampionStore
  readonly ledger: Ledger
}

/**
 * Decide the fate of a candidate that has already PASSED the offline accept rule (it sits at
 * `offline_passed`). Returns the outcome the loop uses for its accounting; writes the ledger.
 */
export function runPromotionGate(config: PromotionGateConfig): PromotionOutcome {
  const { candidate, registry } = config
  const genome = registry.resolve(candidate.change.artifact_ref)
  if (genome === undefined) {
    // Unreachable: the pre-score reconciliation gate already resolved + verified the ref. Fail loud.
    throw new LoopOrchestratorError(
      'GENOME_LOOP.UNRESOLVED_CANDIDATE_GENOME',
      `Candidate ${candidate.candidate_id} reached the promotion gate with an unresolved artifact_ref.`,
      { context: { candidate_id: candidate.candidate_id } },
    )
  }

  // Re-derive the tier from the CONTENT-ADDRESSED genome at the seam — never the declared number.
  const derivedTier = deriveRiskTier(genome).tier

  if (derivedTier <= MAX_AUTONOMOUS_PROMOTION_TIER) {
    return landPromotion(config, genome, {
      fromState: STAGES.offline_passed,
      decidedBy: DECIDED_BY.deterministic_selector,
      rationale: `tier-${derivedTier} auto-promotion (within autonomous authority, no human gate required)`,
    })
  }

  // Tier-2+: the autonomous loop may NOT self-grant authority to land this. Route to human review.
  config.ledger.append({
    candidate_id: candidate.candidate_id,
    from_state: STAGES.offline_passed,
    to_state: STAGES.human_review,
    decided_by: DECIDED_BY.deterministic_selector,
    rationale: `tier-${derivedTier} (commitment_autonomy or higher) requires human approval before landing`,
    evidence_ref: candidate.change.artifact_ref,
  })

  // Phase 4a Step 3 inserts the exogenous-approval lookup here. With no approval, the candidate PARKS.
  return parkCandidate(config, derivedTier)
}

/** Land an accepted candidate: ratchet the champion + ledger the promotion + record lineage. */
function landPromotion(
  config: PromotionGateConfig,
  genome: StrategyGenome,
  transition: { fromState: string; decidedBy: DecidedBy; rationale: string },
): 'promoted' {
  const { candidate, championStore, ledger } = config
  championStore.promote(genome)
  ledger.append({
    candidate_id: candidate.candidate_id,
    from_state: transition.fromState,
    to_state: STAGES.promoted,
    decided_by: transition.decidedBy,
    rationale: transition.rationale,
    evidence_ref: candidate.change.artifact_ref,
  })
  ledger.setFinalDisposition(candidate.candidate_id, FINAL_DISPOSITIONS.promoted)
  // Lineage as ledger evidence (not a proposer lesson — the loop only forwards rejected entries'
  // lessons, so an accepted entry's lineage never pollutes the proposer's context).
  ledger.addLesson(candidate.candidate_id, `champion_lineage: ${candidate.change.artifact_ref}`)
  return 'promoted'
}

/** Withhold a tier-2+ candidate pending oversight: ledger the park, do NOT ratchet the champion. */
function parkCandidate(config: PromotionGateConfig, derivedTier: number): 'parked' {
  const { candidate, ledger } = config
  ledger.append({
    candidate_id: candidate.candidate_id,
    from_state: STAGES.human_review,
    to_state: STAGES.parked,
    decided_by: DECIDED_BY.deterministic_selector,
    rationale: `no exogenous human approval present for the landing; parked pending oversight (tier-${derivedTier})`,
    evidence_ref: candidate.change.artifact_ref,
  })
  ledger.setFinalDisposition(candidate.candidate_id, FINAL_DISPOSITIONS.parked)
  return 'parked'
}
