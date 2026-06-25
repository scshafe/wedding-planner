import { guardSpecsFor } from '@wedding-planner/eval-harness'
import { ManualClock, SequentialIdGenerator, type StrategyGenome } from '@wedding-planner/shared'
import { createMetricEngine } from '@wedding-planner/telemetry'
import {
  AdvisoryProposer,
  type AdvisoryProposerSpec,
  ChampionStore,
  GenomeRegistry,
  HmacTransitionSigner,
  landingKeyFor,
  Ledger,
  runAdvisoryLoop,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

import { ADVISORY_CORPUS, ADVISORY_GUARD_METRICS } from '../fixtures/advisory_corpus'

/**
 * Phase 11 Step 3 — the advisory pass MECHANICS: an AdvisoryProposer + the vision-sensitive advisory
 * corpus + an EMPTY approval store yields a ranked set of PROMOTABLE recommendations (the parked
 * tier-2 candidates), the champion never ratchets, and the frontier-explored certificate fires.
 */

const BASE_TS = '2027-11-01T12:00:00.000Z'

const ADV_SPEC: AdvisoryProposerSpec = {
  target_capability: 'orchestration',
  target_metric_code: 'vision_match_rate',
  expected_direction: 'increase',
  guards_to_watch: ['rsvp_resolution_rate'],
  change_type: 'flow',
}

/** The frozen tier-1 base the advisory recommendations are measured against. */
const ADVISORY_CHAMPION: StrategyGenome = {
  genome_id: 'advisory_base',
  parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0 },
}

function runAdvisory(spec: AdvisoryProposerSpec = ADV_SPEC) {
  const championStore = new ChampionStore(ADVISORY_CHAMPION)
  const registry = new GenomeRegistry()
  const ledger = new Ledger(
    new ManualClock(BASE_TS),
    new SequentialIdGenerator('adv_ledger'),
    new HmacTransitionSigner('phase11-key'),
  )
  const proposer = new AdvisoryProposer(
    new ManualClock(BASE_TS),
    new SequentialIdGenerator('adv_prop'),
    championStore,
    registry,
    spec,
  )
  const result = runAdvisoryLoop({
    proposer,
    championStore,
    registry,
    ledger,
    corpus: ADVISORY_CORPUS,
    guards: guardSpecsFor(ADVISORY_GUARD_METRICS),
    metricEngine: createMetricEngine(),
    harnessVersion: 'h11',
    baseTimestamp: BASE_TS,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('adv_loop'),
  })
  return { championStore, result }
}

describe('runAdvisoryLoop — surfaces honest tier-2 candidates as ranked promotable recommendations', () => {
  it('every emitted tier-2 candidate PARKS → a non-empty recommendation set; none promoted', () => {
    const { result } = runAdvisory()
    expect(result.summary.promoted).toBe(0) // the advisory pass NEVER lands a tier-2 candidate
    expect(result.summary.parked).toBeGreaterThan(0)
    expect(result.recommendations.length).toBe(result.summary.parked)
    expect(result.recommendations.length).toBe(3) // autonomy 1,2,3 each consults → each parks
  })

  it('the champion never ratchets — the advisory pass is read-only over the (frozen) base', () => {
    const { championStore, result } = runAdvisory()
    expect(championStore.current()).toBe(ADVISORY_CHAMPION) // identity: never promoted away
    expect(championStore.current().parameters.autonomy_threshold).toBeUndefined()
    expect(result.summary.parked).toBe(result.summary.accepted)
  })

  it('each recommendation carries the (genome, champion, landing_key, delta) a human would review', () => {
    const { result } = runAdvisory()
    for (const rec of result.recommendations) {
      expect(rec.provenance).toBe('advisory') // tagged so no reader confuses it with a real auto-loop park
      expect(rec.genome.parameters.autonomy_threshold).toBeDefined() // a tier-2 genome
      expect(rec.advisory_champion).toBe(ADVISORY_CHAMPION)
      expect(rec.landing_key).toBe(landingKeyFor(rec.genome, ADVISORY_CHAMPION))
      expect(rec.north_star_delta).toBeGreaterThan(0) // consulting genuinely beats the tier-1 base
    }
  })

  it('recommendations are ranked by north_star_delta descending', () => {
    const { result } = runAdvisory()
    const deltas = result.recommendations.map((r) => r.north_star_delta)
    const sorted = [...deltas].sort((a, b) => b - a)
    expect(deltas).toEqual(sorted)
  })

  it('the frontier-explored certificate fires: proposer converged AND every accept parked', () => {
    const { result } = runAdvisory()
    expect(result.summary.terminatedReason).toBe('converged')
    expect(result.frontierFullyExplored).toBe(true)
  })

  it('a pinned single-level range yields exactly one recommendation, still certified', () => {
    const { result } = runAdvisory({ ...ADV_SPEC, autonomyMin: 1, autonomyMax: 1 })
    expect(result.recommendations.length).toBe(1)
    expect(result.recommendations[0]?.genome.parameters.autonomy_threshold).toBe(1)
    expect(result.frontierFullyExplored).toBe(true)
  })
})
