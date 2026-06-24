import {
  ChampionStore,
  GenomeRegistry,
  reconcileCandidateRiskTier,
  SearchProposer,
  type SearchProposerSpec,
} from '@wedding-planner/loop-orchestrator'
import {
  type CandidateChange,
  canonicalGenomeHash,
  classifyGenomeArtifactRef,
  deriveRiskTier,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

/**
 * Phase 3: the 2-D SearchProposer (search CONTRACT properties, not brittle exact outputs) + the
 * risk-tier reconciliation gate. The proposer enumerates the full (cadence × spacing) box in a fixed
 * champion-independent spread-first order, with a trajectory-relative tabu that re-opens points once
 * the champion ratchets.
 */

const SPEC: SearchProposerSpec = {
  target_capability: 'rsvp',
  target_metric_code: 'rsvp_resolution_rate',
  expected_direction: 'increase',
  guards_to_watch: ['guest_sentiment_score'],
  target_scenario_ids: ['s_anchor'],
  change_type: 'flow',
}

const BOX_SIZE = 16 // default 4×4 (cadence 0..3 × spacing 0..3)

function genome(cadence: number, spacing = 0, genome_id = `g_${cadence}_${spacing}`): StrategyGenome {
  return { genome_id, parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: spacing } }
}

function makeProposer(champion: StrategyGenome = genome(0, 0)): {
  proposer: SearchProposer
  championStore: ChampionStore
  registry: GenomeRegistry
} {
  const championStore = new ChampionStore(champion)
  const registry = new GenomeRegistry()
  const proposer = new SearchProposer(
    new ManualClock('2027-04-01T00:00:00.000Z'),
    new SequentialIdGenerator('searchProposer'),
    championStore,
    registry,
    SPEC,
  )
  return { proposer, championStore, registry }
}

const ctx = (iteration: number, lessons: readonly string[] = []) => ({
  iteration,
  weakestCapability: 'rsvp',
  lessons,
})

/** Drain every proposal for the current (static) champion and return the resolved genomes. */
function drain(proposer: SearchProposer, registry: GenomeRegistry): StrategyGenome[] {
  const out: StrategyGenome[] = []
  for (let i = 0; i < BOX_SIZE * 4; i += 1) {
    const candidate = proposer.propose(ctx(i))
    if (candidate === null) break
    out.push(registry.resolve(candidate.change.artifact_ref) as StrategyGenome)
  }
  return out
}

describe('SearchProposer — emits valid, content-addressed, honestly-tiered candidates', () => {
  it('emits a schema-valid candidate whose artifact_ref content-addresses the registered genome', () => {
    const { proposer, registry } = makeProposer()
    const candidate = proposer.propose(ctx(0)) as CandidateChange
    expect(candidate.author).toBe('ai_proposer')
    const resolved = registry.resolve(candidate.change.artifact_ref)
    expect(resolved).toBeDefined()
    expect(classifyGenomeArtifactRef(resolved as StrategyGenome, candidate.change.artifact_ref)).toBe('match')
  })

  it('declares the HONESTLY DERIVED risk_tier (1 for the two flow knobs), and reconciliation passes', () => {
    const { proposer, registry } = makeProposer()
    const candidate = proposer.propose(ctx(0)) as CandidateChange
    expect(candidate.risk_tier).toBe(1)
    expect(reconcileCandidateRiskTier(candidate, registry).ok).toBe(true)
  })

  // PHASE 4b — the box-is-tier-1 guard (the structural enforcement of
  // [[second-genome-knob-must-stay-tier1]]). The autonomous search may NEVER emit the tier-2
  // escalate-to-couple knob; escalation is exercised only by INJECTED candidates. This pins it as a
  // regression-proof invariant, not a prose intention: EVERY genome the proposer enumerates carries no
  // `autonomy_threshold` and derives tier 1 — so the tier-1 search can never exercise the tier-2
  // escalation path Stage A now wires.
  it('NEVER emits a tier-2 genome: every box point lacks autonomy_threshold and derives tier 1', () => {
    const { proposer, registry } = makeProposer()
    const genomes = drain(proposer, registry)
    expect(genomes.length).toBe(BOX_SIZE - 1) // full box minus the champion
    for (const g of genomes) {
      expect(g.parameters.autonomy_threshold, `${g.genome_id} must not carry the tier-2 knob`).toBeUndefined()
      expect(deriveRiskTier(g).tier).toBe(1)
    }
  })
})

describe('SearchProposer — 2-D box search contract', () => {
  it('exposes the box size (default 4×4 = 16 points)', () => {
    expect(makeProposer().proposer.boxSize).toBe(BOX_SIZE)
  })

  it('sweeps the FULL box minus the champion (exactly boxSize-1 distinct points), then returns null', () => {
    const { proposer, registry, championStore } = makeProposer(genome(0, 0))
    const genomes = drain(proposer, registry)
    expect(genomes.length).toBe(BOX_SIZE - 1)
    // Every proposal is a distinct genome, none is the champion.
    const hashes = new Set(genomes.map(canonicalGenomeHash))
    expect(hashes.size).toBe(BOX_SIZE - 1)
    expect(hashes.has(canonicalGenomeHash(championStore.current()))).toBe(false)
    // The proposed set ∪ {champion} is the WHOLE box.
    expect(hashes.size + 1).toBe(BOX_SIZE)
    expect(proposer.propose(ctx(99))).toBeNull()
    expect(proposer.coverageCompleteFor(championStore.current())).toBe(true)
  })

  it('is SPREAD-FIRST, not champion-local: it reaches a far point early (not distance-1 only)', () => {
    // Phase 2 walked distance-1 neighbours first; the bit-reversal order does NOT. Within the first
    // few proposals off champion (0,0) at least one point is more than one step away on some axis.
    const { proposer, registry } = makeProposer(genome(0, 0))
    const first4 = [0, 1, 2, 3].map(
      (i) => registry.resolve((proposer.propose(ctx(i)) as CandidateChange).change.artifact_ref) as StrategyGenome,
    )
    const reachedFar = first4.some(
      (g) => g.parameters.rsvp_reminder_cadence > 1 || g.parameters.reminder_spacing > 1,
    )
    expect(reachedFar).toBe(true)
  })

  it('the enumeration ORDER is champion-INDEPENDENT (same relative order regardless of champion)', () => {
    // Two proposers with different champions visit the box in the same fixed spread order; the only
    // difference is each skips its own champion. So the common subsequence must match.
    const a = makeProposer(genome(0, 0))
    const b = makeProposer(genome(3, 3))
    const seqA = drain(a.proposer, a.registry).map(canonicalGenomeHash)
    const seqB = drain(b.proposer, b.registry).map(canonicalGenomeHash)
    const championAHash = canonicalGenomeHash(a.championStore.current())
    const championBHash = canonicalGenomeHash(b.championStore.current())
    // Drop each champion from the other's sequence -> identical ordered subsequences.
    expect(seqA.filter((h) => h !== championBHash)).toEqual(seqB.filter((h) => h !== championAHash))
  })

  it('is deterministic: same champion + same call sequence -> identical proposals', () => {
    const refs = (): string[] => {
      const { proposer, registry } = makeProposer(genome(1, 1))
      return drain(proposer, registry).map(canonicalGenomeHash)
    }
    expect(refs()).toEqual(refs())
  })

  it('NEVER re-proposes a genome against the SAME champion (per-champion dedupe)', () => {
    const { proposer, championStore } = makeProposer(genome(0, 0))
    const seen = new Set<string>()
    for (let i = 0; i < BOX_SIZE; i += 1) {
      const candidate = proposer.propose(ctx(i))
      if (candidate === null) break
      expect(seen.has(candidate.change.artifact_ref)).toBe(false)
      seen.add(candidate.change.artifact_ref)
    }
    expect(proposer.evaluatedCountFor(canonicalGenomeHash(championStore.current()))).toBe(BOX_SIZE - 1)
  })
})

describe('SearchProposer — trajectory-relative tabu (re-opens after the champion ratchets)', () => {
  it('a point tried against a PRIOR champion is eligible again against the NEW champion', () => {
    const { proposer, championStore, registry } = makeProposer(genome(0, 0))
    // Exhaust the box against champion A.
    const triedVsA = new Set(drain(proposer, registry).map(canonicalGenomeHash))
    expect(proposer.propose(ctx(100))).toBeNull()

    // Promote to a different champion B (a point that was tried vs A).
    const B = genome(2, 1)
    championStore.promote(B)
    expect(proposer.coverageCompleteFor(B)).toBe(false) // fresh coverage for B

    const vsB = drain(proposer, registry).map(canonicalGenomeHash)
    expect(vsB.length).toBe(BOX_SIZE - 1) // a full fresh sweep against B
    // Re-eligibility: at least one genome proposed vs A is proposed AGAIN vs B (global tabu would not).
    const reproposed = vsB.filter((h) => triedVsA.has(h))
    expect(reproposed.length).toBeGreaterThan(0)
    // ...and B itself is never re-proposed.
    expect(vsB).not.toContain(canonicalGenomeHash(B))
  })
})

describe('risk-tier reconciliation — the firewall re-derives, never trusts the declared number', () => {
  it('REJECTS an under-declared candidate (declares tier 0, carries a tier-1 genome) + signals evasion', () => {
    const registry = new GenomeRegistry()
    const artifactRef = registry.register(genome(2, 1))
    const malicious: CandidateChange = {
      candidate_id: 'cand_evil',
      created_at: '2027-04-01T00:00:00.000Z',
      author: 'ai_proposer',
      hypothesis: {
        target_capability: 'rsvp',
        target_metric_code: 'rsvp_resolution_rate',
        expected_direction: 'increase',
        guards_to_watch: ['guest_sentiment_score'],
        rationale: 'pretend this is cosmetic',
      },
      change: {
        change_type: 'flow',
        summary: 'under-declared',
        artifact_ref: artifactRef,
        reversible: true,
        capabilities_touched: ['rsvp'],
      },
      risk_tier: 0, // LIE: derived tier is 1
      status: 'proposed',
    }
    const reconciliation = reconcileCandidateRiskTier(malicious, registry)
    expect(reconciliation.ok).toBe(false)
    if (!reconciliation.ok) {
      expect(reconciliation.reason).toBe('under_declared')
      expect(reconciliation.derivedTier).toBe(1)
      expect(reconciliation.declaredTier).toBe(0)
    }
  })

  it('REJECTS an unresolved or malformed artifact_ref (refuse-and-halt)', () => {
    const registry = new GenomeRegistry()
    const base = buildTierOk(registry)
    const unresolved = { ...base, change: { ...base.change, artifact_ref: 'genome:deadbeef' } }
    expect(reconcileCandidateRiskTier(unresolved, registry).ok).toBe(false)
    const malformed = { ...base, change: { ...base.change, artifact_ref: 'branch:nope' } }
    const result = reconcileCandidateRiskTier(malformed, registry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unresolved_ref')
  })

  it('HONORS over-declaration (declared > derived is allowed)', () => {
    const registry = new GenomeRegistry()
    const over = buildTierOk(registry, 2) // declares tier 2 over a tier-1 genome
    expect(reconcileCandidateRiskTier(over, registry).ok).toBe(true)
  })
})

/** A reconciliation-passing candidate over a freshly-registered tier-1 genome. */
function buildTierOk(registry: GenomeRegistry, declaredTier: 0 | 1 | 2 | 3 = 1): CandidateChange {
  const artifactRef = registry.register(genome(1, 1))
  return {
    candidate_id: 'cand_ok',
    created_at: '2027-04-01T00:00:00.000Z',
    author: 'ai_proposer',
    hypothesis: {
      target_capability: 'rsvp',
      target_metric_code: 'rsvp_resolution_rate',
      expected_direction: 'increase',
      guards_to_watch: ['guest_sentiment_score'],
      rationale: 'ok',
    },
    change: {
      change_type: 'flow',
      summary: 'ok',
      artifact_ref: artifactRef,
      reversible: true,
      capabilities_touched: ['rsvp'],
    },
    risk_tier: declaredTier,
    status: 'proposed',
  }
}
