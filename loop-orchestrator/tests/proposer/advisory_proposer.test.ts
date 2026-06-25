import {
  AdvisoryProposer,
  type AdvisoryProposerSpec,
  ChampionStore,
  GenomeRegistry,
  reconcileCandidateRiskTier,
  SearchProposer,
  type SearchProposerSpec,
} from '@wedding-planner/loop-orchestrator'
import {
  type CandidateChange,
  classifyGenomeArtifactRef,
  deriveRiskTier,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

/**
 * Phase 11 — the AdvisoryProposer is the deliberate tier-2 counterpart of SearchProposer. The two are
 * pinned as a PAIR: SearchProposer emits ONLY tier-1 genomes (so the auto-landing search can never
 * exercise tier-2), and AdvisoryProposer emits ONLY tier-2 genomes (so it can only ever be wired into
 * the advisory pass, where the promotion gate parks them). The "box is tier-1" guarantee and the
 * "advisory is tier-2" guarantee are both structural — neither proposer can become the other.
 */

const ADV_SPEC: AdvisoryProposerSpec = {
  target_capability: 'orchestration',
  target_metric_code: 'vision_match_rate',
  expected_direction: 'increase',
  guards_to_watch: ['rsvp_resolution_rate'],
  change_type: 'flow',
}

const SEARCH_SPEC: SearchProposerSpec = {
  target_capability: 'rsvp',
  target_metric_code: 'rsvp_resolution_rate',
  expected_direction: 'increase',
  guards_to_watch: ['guest_sentiment_score'],
  change_type: 'flow',
}

/** A tier-1 base champion (no autonomy_threshold). */
function tier1Genome(cadence = 1): StrategyGenome {
  return { genome_id: `g_${cadence}`, parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: 0, reminder_batching: 0 } }
}

function makeAdvisory(champion: StrategyGenome = tier1Genome(), spec: AdvisoryProposerSpec = ADV_SPEC): {
  proposer: AdvisoryProposer
  championStore: ChampionStore
  registry: GenomeRegistry
} {
  const championStore = new ChampionStore(champion)
  const registry = new GenomeRegistry()
  const proposer = new AdvisoryProposer(
    new ManualClock('2027-04-01T00:00:00.000Z'),
    new SequentialIdGenerator('advisoryProposer'),
    championStore,
    registry,
    spec,
  )
  return { proposer, championStore, registry }
}

const ctx = (iteration: number, lessons: readonly string[] = []) => ({
  iteration,
  weakestCapability: 'orchestration',
  lessons,
})

/** Drain every proposal against the (static) champion and return the resolved genomes. */
function drain(proposer: AdvisoryProposer, registry: GenomeRegistry): StrategyGenome[] {
  const out: StrategyGenome[] = []
  for (let i = 0; i < proposer.boxSize * 4; i += 1) {
    const candidate = proposer.propose(ctx(i))
    if (candidate === null) break
    out.push(registry.resolve(candidate.change.artifact_ref) as StrategyGenome)
  }
  return out
}

describe('AdvisoryProposer — emits valid, content-addressed, HONESTLY tier-2 candidates', () => {
  it('emits a schema-valid candidate whose artifact_ref content-addresses the registered tier-2 genome', () => {
    const { proposer, registry } = makeAdvisory()
    const candidate = proposer.propose(ctx(0)) as CandidateChange
    expect(candidate.author).toBe('ai_proposer')
    const resolved = registry.resolve(candidate.change.artifact_ref) as StrategyGenome
    expect(classifyGenomeArtifactRef(resolved, candidate.change.artifact_ref)).toBe('match')
    expect(resolved.parameters.autonomy_threshold).toBeDefined()
  })

  it('declares the HONESTLY DERIVED tier 2 (autonomy_threshold present), and reconciliation passes', () => {
    const { proposer, registry } = makeAdvisory()
    const candidate = proposer.propose(ctx(0)) as CandidateChange
    expect(candidate.risk_tier).toBe(2) // honest tier 2 — so it reconciles and reaches the park, not a firewall reject
    expect(reconcileCandidateRiskTier(candidate, registry).ok).toBe(true)
  })

  // The paired guard (doddy P1-B): the advisory proposer emits ONLY tier-2 genomes, carrying the tier-1
  // base flow knobs verbatim plus exactly one autonomy_threshold per emitted point.
  it('EVERY candidate is tier-2: carries autonomy_threshold over the SAME tier-1 base, derives tier 2', () => {
    const base = tier1Genome(2)
    const { proposer, registry } = makeAdvisory(base)
    const genomes = drain(proposer, registry)
    expect(genomes.length).toBe(proposer.boxSize) // every autonomy level (champion is NOT one of the points)
    const seenAutonomy = new Set<number>()
    for (const g of genomes) {
      expect(g.parameters.autonomy_threshold, `${g.genome_id} must carry the tier-2 knob`).toBeDefined()
      expect(deriveRiskTier(g).tier).toBe(2)
      // The tier-1 base is carried verbatim — only autonomy_threshold varies.
      expect(g.parameters.rsvp_reminder_cadence).toBe(base.parameters.rsvp_reminder_cadence)
      expect(g.parameters.reminder_spacing).toBe(base.parameters.reminder_spacing)
      expect(g.parameters.reminder_batching).toBe(base.parameters.reminder_batching)
      seenAutonomy.add(g.parameters.autonomy_threshold as number)
    }
    expect([...seenAutonomy].sort()).toEqual([1, 2, 3]) // the default autonomy range
  })

  it('CONVERGES: once every autonomy level is proposed against the standing champion, propose() returns null + isConverged', () => {
    const { proposer, registry } = makeAdvisory()
    drain(proposer, registry)
    expect(proposer.propose(ctx(99))).toBeNull()
    expect(proposer.isConverged()).toBe(true)
  })

  it('respects a pinned autonomy range (1..1 emits exactly one tier-2 candidate)', () => {
    const { proposer, registry } = makeAdvisory(tier1Genome(), { ...ADV_SPEC, autonomyMin: 1, autonomyMax: 1 })
    const genomes = drain(proposer, registry)
    expect(genomes.length).toBe(1)
    expect(genomes[0]?.parameters.autonomy_threshold).toBe(1)
  })
})

describe('the proposer PAIR is structurally fenced — neither can become the other', () => {
  it('SearchProposer emits ONLY tier-1; AdvisoryProposer emits ONLY tier-2 (over the same champion)', () => {
    const champion = tier1Genome()

    const searchRegistry = new GenomeRegistry()
    const search = new SearchProposer(
      new ManualClock('2027-04-01T00:00:00.000Z'),
      new SequentialIdGenerator('search'),
      new ChampionStore(champion),
      searchRegistry,
      SEARCH_SPEC,
    )
    for (let i = 0; i < 64 * 4; i += 1) {
      const c = search.propose(ctx(i))
      if (c === null) break
      const g = searchRegistry.resolve(c.change.artifact_ref) as StrategyGenome
      expect(g.parameters.autonomy_threshold).toBeUndefined()
      expect(deriveRiskTier(g).tier).toBe(1)
    }

    const { proposer: advisory, registry: advRegistry } = makeAdvisory(champion)
    for (const g of drain(advisory, advRegistry)) {
      expect(g.parameters.autonomy_threshold).toBeDefined()
      expect(deriveRiskTier(g).tier).toBe(2)
    }
  })
})
