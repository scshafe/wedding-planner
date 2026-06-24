import {
  type CandidateChange,
  genomeArtifactRef,
  getSchemaRegistry,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import {
  ChampionStore,
  GenomeRegistry,
  HmacTransitionSigner,
  Ledger,
  MAX_AUTONOMOUS_PROMOTION_TIER,
  runPromotionGate,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

/**
 * Phase 4a Step 2: the promotion gate's tier branch. An accepted candidate (already at offline_passed)
 * either LANDS (tier <= 1, ratchet the champion) or PARKS (tier 2+, no exogenous approval yet — Step 3
 * adds the approval lookup). The gate re-derives the tier from the CONTENT-ADDRESSED genome at the seam,
 * never from the candidate's self-declared risk_tier. Every decision is a tamper-evident ledger
 * transition.
 */

const SEED: StrategyGenome = { genome_id: 'seed', parameters: { rsvp_reminder_cadence: 0, reminder_spacing: 0 } }

/** A tier-1 genome (omits autonomy_threshold). */
function tier1Genome(cadence: number, spacing = 1): StrategyGenome {
  return { genome_id: `g_${cadence}_${spacing}`, parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: spacing } }
}

/** A tier-2 genome (carries autonomy_threshold — presence elevates the whole genome). */
function tier2Genome(autonomy: number): StrategyGenome {
  return {
    genome_id: `g_t2_${autonomy}`,
    parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 1, autonomy_threshold: autonomy },
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
