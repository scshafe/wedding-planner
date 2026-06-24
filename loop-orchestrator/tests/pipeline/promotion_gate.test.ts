import {
  type CandidateChange,
  genomeArtifactRef,
  getSchemaRegistry,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import {
  ApprovalStore,
  ChampionStore,
  GenomeRegistry,
  HmacTransitionSigner,
  landingKeyFor,
  Ledger,
  MAX_AUTONOMOUS_PROMOTION_TIER,
  runPromotionGate,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

import { humanApproval } from '../fixtures/oversight_fixtures'

/**
 * Phase 4a Step 2: the promotion gate's tier branch. An accepted candidate (already at offline_passed)
 * either LANDS (tier <= 1, ratchet the champion) or PARKS (tier 2+, no exogenous approval yet — Step 3
 * adds the approval lookup). The gate re-derives the tier from the CONTENT-ADDRESSED genome at the seam,
 * never from the candidate's self-declared risk_tier. Every decision is a tamper-evident ledger
 * transition.
 */

const SEED: StrategyGenome = { genome_id: 'seed', parameters: { rsvp_reminder_cadence: 0, reminder_spacing: 0, reminder_batching: 0 } }

/** A tier-1 genome (omits autonomy_threshold). */
function tier1Genome(cadence: number, spacing = 1): StrategyGenome {
  return { genome_id: `g_${cadence}_${spacing}`, parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: spacing, reminder_batching: 0 } }
}

/** A tier-2 genome (carries autonomy_threshold — presence elevates the whole genome). */
function tier2Genome(autonomy: number): StrategyGenome {
  return {
    genome_id: `g_t2_${autonomy}`,
    parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 1, reminder_batching: 0, autonomy_threshold: autonomy },
  }
}

/** Build a schema-valid candidate that commits to `genome`, declaring `declaredTier`. */
function candidateFor(genome: StrategyGenome, declaredTier: 0 | 1 | 2 | 3): CandidateChange {
  const candidate: CandidateChange = {
    candidate_id: `cand_${genome.genome_id}`,
    created_at: '2027-05-01T12:00:00.000Z',
    author: 'ai_proposer',
    hypothesis: {
      target_capability: 'rsvp',
      target_metric_code: 'rsvp_resolution_rate',
      expected_direction: 'increase',
      guards_to_watch: ['rsvp_resolution_rate'],
      rationale: 'gate unit test',
    },
    change: {
      change_type: 'flow',
      summary: 'gate unit test candidate',
      artifact_ref: genomeArtifactRef(genome),
      reversible: true,
      capabilities_touched: ['rsvp'],
      mid_engagement_safe: true,
    },
    risk_tier: declaredTier,
    status: 'proposed',
  }
  return getSchemaRegistry().assertValid<CandidateChange>('candidate_change', candidate)
}

function harness() {
  const registry = new GenomeRegistry()
  const championStore = new ChampionStore(SEED)
  const ledger = new Ledger(
    new ManualClock('2027-05-01T12:00:00.000Z'),
    new SequentialIdGenerator('gateLedger'),
    new HmacTransitionSigner('gate-key'),
  )
  return { registry, championStore, ledger }
}

/** Seed a candidate's ledger entry at offline_passed (where the gate picks it up). */
function seedAcceptedEntry(ledger: Ledger, candidate: CandidateChange): void {
  ledger.append({
    candidate_id: candidate.candidate_id,
    from_state: 'offline_scoring',
    to_state: 'offline_passed',
    decided_by: 'deterministic_selector',
    rationale: 'passed all four accept-rule conditions',
  })
}

describe('promotion gate — tier branch (Phase 4a Step 2)', () => {
  it('LANDS a tier-1 candidate: ratchets the champion + ledgers offline_passed -> promoted', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier1Genome(2)
    registry.register(genome)
    const candidate = candidateFor(genome, 1)
    seedAcceptedEntry(ledger, candidate)

    const outcome = runPromotionGate({ candidate, registry, championStore, ledger })

    expect(outcome).toBe('promoted')
    expect(championStore.current().parameters.rsvp_reminder_cadence).toBe(2)
    const entry = ledger.getEntry(candidate.candidate_id)
    expect(entry?.state_transitions.at(-1)?.to_state).toBe('promoted')
    expect(entry?.final_disposition).toBe('promoted')
    expect(entry?.lessons).toContain(`champion_lineage: ${candidate.change.artifact_ref}`)
  })

  it('PARKS a tier-2 candidate: champion UNCHANGED, ledgers offline_passed -> human_review -> parked', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier2Genome(1)
    registry.register(genome)
    const candidate = candidateFor(genome, 2) // honestly declared tier-2
    seedAcceptedEntry(ledger, candidate)

    const outcome = runPromotionGate({ candidate, registry, championStore, ledger })

    expect(outcome).toBe('parked')
    // The autonomous loop did NOT self-grant tier-2 autonomy: the champion is still the seed.
    expect(championStore.current()).toBe(SEED)
    const states = ledger.getEntry(candidate.candidate_id)?.state_transitions.map((t) => t.to_state)
    expect(states).toEqual(['offline_passed', 'human_review', 'parked'])
    expect(ledger.getEntry(candidate.candidate_id)?.final_disposition).toBe('parked')
    // No lineage lesson for a parked (un-landed) candidate.
    expect(ledger.getEntry(candidate.candidate_id)?.lessons ?? []).not.toContain(`champion_lineage: ${candidate.change.artifact_ref}`)
  })

  it('re-derives the tier at the seam: a candidate whose risk_tier is FORGED to 1 over a tier-2 genome still PARKS', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier2Genome(2)
    registry.register(genome)
    const candidate = candidateFor(genome, 1) // declared 1, but the genome derives to 2
    seedAcceptedEntry(ledger, candidate)

    const outcome = runPromotionGate({ candidate, registry, championStore, ledger })

    // The gate trusts the content-addressed derivation, not the declared number.
    expect(outcome).toBe('parked')
    expect(championStore.current()).toBe(SEED)
  })

  it('the autonomous-authority ceiling is tier 1', () => {
    expect(MAX_AUTONOMOUS_PROMOTION_TIER).toBe(1)
  })
})

describe('promotion gate — the exogenous human approval (Phase 4a Step 3)', () => {
  it('PROMOTES a tier-2 candidate with a matching approved approval: human_review -> promoted (by human)', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier2Genome(1)
    registry.register(genome)
    const candidate = candidateFor(genome, 2)
    seedAcceptedEntry(ledger, candidate)
    // The approval binds (this genome, the CURRENT champion = SEED).
    const key = landingKeyFor(genome, SEED)
    const approvals = new ApprovalStore([humanApproval(key, true)])

    const outcome = runPromotionGate({ candidate, registry, championStore, ledger, approvals })

    expect(outcome).toBe('promoted')
    expect(championStore.current()).toBe(genome) // the champion ratcheted to the approved tier-2 genome
    const states = ledger.getEntry(candidate.candidate_id)?.state_transitions
    expect(states?.map((t) => t.to_state)).toEqual(['offline_passed', 'human_review', 'promoted'])
    expect(states?.at(-1)?.decided_by).toBe('human')
    expect(ledger.getEntry(candidate.candidate_id)?.final_disposition).toBe('promoted')
  })

  it('REJECTS a tier-2 candidate with a matching approved:false approval: human_review -> human_rejected', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier2Genome(1)
    registry.register(genome)
    const candidate = candidateFor(genome, 2)
    seedAcceptedEntry(ledger, candidate)
    const key = landingKeyFor(genome, SEED)
    const approvals = new ApprovalStore([humanApproval(key, false)])

    const outcome = runPromotionGate({ candidate, registry, championStore, ledger, approvals })

    expect(outcome).toBe('human_rejected')
    expect(championStore.current()).toBe(SEED) // not landed
    const states = ledger.getEntry(candidate.candidate_id)?.state_transitions.map((t) => t.to_state)
    expect(states).toEqual(['offline_passed', 'human_review', 'human_rejected'])
    expect(ledger.getEntry(candidate.candidate_id)?.final_disposition).toBe('rejected_human')
  })

  it('PARKS when the approval is bound to a DIFFERENT champion (a stale, pre-ratchet approval)', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier2Genome(1)
    registry.register(genome)
    const candidate = candidateFor(genome, 2)
    seedAcceptedEntry(ledger, candidate)
    // Approval was minted against a DIFFERENT champion than the current SEED — its key won't match.
    const staleChampion: StrategyGenome = { genome_id: 'other', parameters: { rsvp_reminder_cadence: 3, reminder_spacing: 3, reminder_batching: 0 } }
    const approvals = new ApprovalStore([humanApproval(landingKeyFor(genome, staleChampion), true)])

    const outcome = runPromotionGate({ candidate, registry, championStore, ledger, approvals })

    expect(outcome).toBe('parked')
    expect(championStore.current()).toBe(SEED)
  })

  it('PARKS when the approval is bound to a DIFFERENT genome', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier2Genome(1)
    registry.register(genome)
    const candidate = candidateFor(genome, 2)
    seedAcceptedEntry(ledger, candidate)
    // Approval is for a different tier-2 genome (autonomy 2), not the candidate's (autonomy 1).
    const approvals = new ApprovalStore([humanApproval(landingKeyFor(tier2Genome(2), SEED), true)])

    expect(runPromotionGate({ candidate, registry, championStore, ledger, approvals })).toBe('parked')
    expect(championStore.current()).toBe(SEED)
  })

  it('one approval is one-shot: it cannot promote a second candidate sharing the same (genome, champion)', () => {
    const { registry, championStore, ledger } = harness()
    const genome = tier2Genome(1)
    registry.register(genome)
    const key = landingKeyFor(genome, SEED)
    const approvals = new ApprovalStore([humanApproval(key, true)])

    // First candidate against SEED: promotes (and the champion becomes `genome`).
    const first = candidateFor(genome, 2)
    seedAcceptedEntry(ledger, first)
    expect(runPromotionGate({ candidate: first, registry, championStore, ledger, approvals })).toBe('promoted')

    // A second candidate carrying the SAME genome — re-seat the champion to SEED to reconstruct the same
    // landing key — must NOT re-spend the approval.
    championStore.promote(SEED)
    const second: CandidateChange = { ...candidateFor(genome, 2), candidate_id: 'cand_second' }
    seedAcceptedEntry(ledger, second)
    expect(runPromotionGate({ candidate: second, registry, championStore, ledger, approvals })).toBe('parked')
  })
})
