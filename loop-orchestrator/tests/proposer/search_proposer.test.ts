import {
  ChampionStore,
  GenomeRegistry,
  reconcileCandidateRiskTier,
  SearchProposer,
  type SearchProposerSpec,
} from '@wedding-planner/loop-orchestrator'
import {
  type CandidateChange,
  classifyGenomeArtifactRef,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

/**
 * Step 6: the SearchProposer (search CONTRACT properties, not brittle exact outputs) + the risk-tier
 * reconciliation gate (the firewall re-derives from the genome; under-declaration is rejected).
 */

const SPEC: SearchProposerSpec = {
  target_capability: 'rsvp',
  target_metric_code: 'rsvp_resolution_rate',
  expected_direction: 'increase',
  guards_to_watch: ['guest_sentiment_score'],
  target_scenario_ids: ['s_anchor'],
  change_type: 'flow',
}

function genome(cadence: number, genome_id = `g_${cadence}`): StrategyGenome {
  return { genome_id, parameters: { rsvp_reminder_cadence: cadence } }
}

function makeProposer(championCadence = 0): {
  proposer: SearchProposer
  champion: ChampionStore
  registry: GenomeRegistry
} {
  const champion = new ChampionStore(genome(championCadence))
  const registry = new GenomeRegistry()
  const proposer = new SearchProposer(
    new ManualClock('2027-04-01T00:00:00.000Z'),
    new SequentialIdGenerator('searchProposer'),
    champion,
    registry,
    SPEC,
  )
  return { proposer, champion, registry }
}

const ctx = (iteration: number, lessons: readonly string[] = []) => ({
  iteration,
  weakestCapability: 'rsvp',
  lessons,
})

describe('SearchProposer — emits valid, content-addressed, honestly-tiered candidates', () => {
  it('emits a schema-valid candidate whose artifact_ref content-addresses the registered genome', () => {
    const { proposer, registry } = makeProposer(0)
    const candidate = proposer.propose(ctx(0)) as CandidateChange
    expect(candidate.author).toBe('ai_proposer')
    const resolved = registry.resolve(candidate.change.artifact_ref)
    expect(resolved).toBeDefined()
    expect(classifyGenomeArtifactRef(resolved as StrategyGenome, candidate.change.artifact_ref)).toBe('match')
  })

  it('declares the HONESTLY DERIVED risk_tier (1 for the cadence flow knob), and reconciliation passes', () => {
    const { proposer, registry } = makeProposer(0)
    const candidate = proposer.propose(ctx(0)) as CandidateChange
    expect(candidate.risk_tier).toBe(1)
    const reconciliation = reconcileCandidateRiskTier(candidate, registry)
    expect(reconciliation.ok).toBe(true)
  })
})

describe('SearchProposer — search contract properties', () => {
  it('NEVER re-proposes a genome it already emitted (dedupe on the genome hash)', () => {
    const { proposer } = makeProposer(0)
    const seen = new Set<string>()
    for (let i = 0; i < 10; i += 1) {
      const candidate = proposer.propose(ctx(i))
      if (candidate === null) break
      expect(seen.has(candidate.change.artifact_ref)).toBe(false)
      seen.add(candidate.change.artifact_ref)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('terminates (returns null) once the bounded neighborhood is exhausted (without promotion)', () => {
    const { proposer } = makeProposer(0)
    let proposals = 0
    for (let i = 0; i < 50; i += 1) {
      if (proposer.propose(ctx(i)) === null) break
      proposals += 1
    }
    // Invariant: a static champion has at most |range|-1 reachable neighbors, then null. (For the
    // current {0..3} range with champion 0 that is 3; assert the bound + termination, not the literal.)
    const reachableNeighborhoodBound = 3
    expect(proposals).toBeGreaterThan(0)
    expect(proposals).toBeLessThanOrEqual(reachableNeighborhoodBound)
    expect(proposer.propose(ctx(99))).toBeNull()
  })

  it('the first move off the champion is an EXPLOIT (distance-1) neighbor', () => {
    const { proposer, registry } = makeProposer(1)
    const candidate = proposer.propose(ctx(0)) as CandidateChange
    const resolved = registry.resolve(candidate.change.artifact_ref) as StrategyGenome
    // Test the move STRUCTURALLY (the resolved cadence's distance from the champion), not by
    // substring-matching the rationale prose (wolf Step-6: don't pin incidental output).
    // Champion cadence 1 -> nearest neighbors are 2 and 0 (distance 1); the first must be one of them.
    expect([0, 2]).toContain(resolved.parameters.rsvp_reminder_cadence)
  })

  it('is deterministic: same champion + same call sequence -> identical proposals', () => {
    const refsOf = (championCadence: number): string[] => {
      const { proposer } = makeProposer(championCadence)
      const refs: string[] = []
      for (let i = 0; i < 5; i += 1) {
        const candidate = proposer.propose(ctx(i))
        if (candidate === null) break
        refs.push(candidate.change.artifact_ref)
      }
      return refs
    }
    expect(refsOf(0)).toEqual(refsOf(0))
  })

  it('coverage grows within a single (un-promoted) champion: each proposal is a new cadence', () => {
    // This is the SINGLE-CHAMPION coverage property (no promotion here). The post-promotion
    // re-centering property — that the proposer explores the NEW champion's neighborhood — is an
    // integration property tested with the loop wiring in Step 7 (wolf's highest-value missing test).
    const { proposer, registry } = makeProposer(0)
    const cadences = new Set<number>()
    for (let i = 0; i < 10; i += 1) {
      const candidate = proposer.propose(ctx(i))
      if (candidate === null) break
      const g = registry.resolve(candidate.change.artifact_ref) as StrategyGenome
      const before = cadences.size
      cadences.add(g.parameters.rsvp_reminder_cadence)
      expect(cadences.size).toBe(before + 1) // each proposal is a new cadence
    }
  })
})

describe('risk-tier reconciliation — the firewall re-derives, never trusts the declared number', () => {
  it('REJECTS an under-declared candidate (declares tier 0, carries a tier-1 genome) + signals evasion', () => {
    // A malicious candidate: it content-addresses a real tier-1 genome but lies that it is tier 0.
    const registry = new GenomeRegistry()
    const g = genome(2)
    const artifactRef = registry.register(g)
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
    const base = { ...buildTierOk(registry) }
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
  const artifactRef = registry.register(genome(1))
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
