import { type CandidateChange, deriveRiskTier, type StrategyGenome } from '@wedding-planner/shared'

import { type ChampionStore } from '../genome/champion_store'
import { type GenomeRegistry } from '../genome/genome_registry'
import { type Ledger } from '../ledger/ledger'
import { type PromotionOutcome } from '../loop/offline_loop'
import { type DecidedBy, DECIDED_BY, FINAL_DISPOSITIONS, STAGES } from '../loop_orchestrator_constants'
import { LoopOrchestratorError } from '../loop_orchestrator_error'
import { type ApprovalStore, type MatchedApproval, landingKeyFor } from './landing_approval'

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
  /**
   * The exogenous human-approval channel (Phase 4a Step 3). Read-only: the gate consumes approvals it
   * never authored. Absent (the autonomous default), every tier-2 candidate parks — the safe outcome.
   */
  readonly approvals?: ApprovalStore
  /**
   * Optional provenance note stamped onto a PARK ledger transition (Phase 11, doddy P2). Lets a park
   * self-identify its origin so an advisory-exploration park (which never entered the auto-loop) can
   * never be mistaken for a real auto-loop park awaiting approval, even if the entries were ever read
   * outside their isolated ledger. The auto-landing loop omits it; the advisory pass sets it.
   */
  readonly parkProvenanceNote?: string
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

  // Re-derive the landing key from the CURRENT champion + the content-addressed genome, and look for an
  // exogenous approval bound to exactly that (genome, champion) landing. No approval (the autonomous
  // default, and also a stale approval after the champion ratcheted) => PARK.
  const landingKey = landingKeyFor(genome, config.championStore.current())
  const approval = config.approvals?.find(landingKey)
  if (approval === undefined) {
    return parkCandidate(config, derivedTier)
  }

  // One approval authorizes one landing: spend it whether it approves or rejects, so it cannot be
  // re-used for another candidate sharing this exact (genome, champion) landing.
  config.approvals?.markSpent(landingKey)

  if (approval.humanGate.approved) {
    return landPromotion(config, genome, {
      fromState: STAGES.human_review,
      decidedBy: DECIDED_BY.human,
      rationale:
        `human approval ${approval.reviewId} (${approval.humanGate.approver_role}) cleared the ` +
        `tier-${derivedTier} landing`,
    })
  }
  return rejectAtHumanGate(config, approval, derivedTier)
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

/** A present human rejection (`approved:false`): terminal `human_rejected`, NOT parked-for-retry. */
function rejectAtHumanGate(
  config: PromotionGateConfig,
  approval: MatchedApproval,
  derivedTier: number,
): 'human_rejected' {
  const { candidate, ledger } = config
  ledger.append({
    candidate_id: candidate.candidate_id,
    from_state: STAGES.human_review,
    to_state: STAGES.human_rejected,
    decided_by: DECIDED_BY.human,
    rationale:
      `human approval ${approval.reviewId} (${approval.humanGate.approver_role}) REJECTED the ` +
      `tier-${derivedTier} landing`,
    evidence_ref: candidate.change.artifact_ref,
  })
  ledger.setFinalDisposition(candidate.candidate_id, FINAL_DISPOSITIONS.rejected_human)
  return 'human_rejected'
}

/** Withhold a tier-2+ candidate pending oversight: ledger the park, do NOT ratchet the champion. */
function parkCandidate(config: PromotionGateConfig, derivedTier: number): 'parked' {
  const { candidate, ledger } = config
  const provenance = config.parkProvenanceNote === undefined ? '' : ` [${config.parkProvenanceNote}]`
  ledger.append({
    candidate_id: candidate.candidate_id,
    from_state: STAGES.human_review,
    to_state: STAGES.parked,
    decided_by: DECIDED_BY.deterministic_selector,
    rationale: `no exogenous human approval present for the landing; parked pending oversight (tier-${derivedTier})${provenance}`,
    evidence_ref: candidate.change.artifact_ref,
  })
  ledger.setFinalDisposition(candidate.candidate_id, FINAL_DISPOSITIONS.parked)
  return 'parked'
}
