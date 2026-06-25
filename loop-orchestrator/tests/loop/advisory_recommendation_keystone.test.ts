import { guardSpecsFor, type Planner, rsvpCadencePlanner } from '@wedding-planner/eval-harness'
import {
  type EventEnvelope,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { createMetricEngine, EVENT_NAMES } from '@wedding-planner/telemetry'
import {
  AdvisoryProposer,
  type AdvisoryProposerSpec,
  ChampionStore,
  GenomeRegistry,
  HmacTransitionSigner,
  Ledger,
  runAdvisoryLoop,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

import { ADVISORY_CORPUS, ADVISORY_GUARD_METRICS } from '../fixtures/advisory_corpus'

/**
 * Phase 11 KEYSTONE — the advisory pass is load-bearing AND provably safe (doddy P1-C).
 *
 * It explores tier-2 candidates over a vision-sensitive corpus and surfaces the firewall-clean,
 * accept-rule-passing ones as ranked PROMOTABLE recommendations — while being structurally incapable of
 * landing tier-2 autonomously. The load-bearing facts, each asserted directly:
 *  - PARKS-NEVER-PROMOTES: every accepted tier-2 candidate parks; the champion never ratchets.
 *  - ISOLATION: the advisory pass touches only its own stores — a separate (real) champion store is
 *    byte-identical untouched.
 *  - FIREWALL-PROTECTED REC SET: a forged candidate (an honest tier-2 alignment whose vision_consult
 *    COST is suppressed — same vision, sub-tier-2 cost, so it would out-rank the honest companions) is
 *    VETOED and EXCLUDED from the recommendation set. A human never sees a dishonest recommendation.
 *  - GUARD-SET IS LOAD-BEARING: the positive rule (value metrics MINUS couple_active_minutes_total) is
 *    why recommendations exist at all — guarding the cost (the double-count) rejects every candidate.
 *  - HONEST SURFACED: the honest companions are surfaced with a positive North-Star delta.
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

/** Suppress every vision_consult couple session — a CLEAN cost-only forge (vision held at 1.0). The
 *  tier-1 champion never emits one (it doesn't consult), so this lies only for the tier-2 candidates. */
const suppressVisionConsult: Planner = (input) => {
  const honest = [...rsvpCadencePlanner(input)]
  return honest.filter(
    (e: EventEnvelope) =>
      !(
        e.event_name === EVENT_NAMES.couple_session_ended &&
        (e.payload as { session_reason?: string }).session_reason === 'vision_consult'
      ),
  )
}

function runAdvisory(opts: { guardMetrics?: readonly string[]; planner?: Planner; champion?: StrategyGenome } = {}) {
  const championStore = new ChampionStore(opts.champion ?? ADVISORY_CHAMPION)
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
    ADV_SPEC,
  )
  const result = runAdvisoryLoop({
    proposer,
    championStore,
    registry,
    ledger,
    corpus: ADVISORY_CORPUS,
    guards: guardSpecsFor(opts.guardMetrics ?? ADVISORY_GUARD_METRICS),
    metricEngine: createMetricEngine(),
    harnessVersion: 'h11',
    baseTimestamp: BASE_TS,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('adv_loop'),
    ...(opts.planner === undefined ? {} : { planner: opts.planner }),
  })
  return { championStore, ledger, result }
}

describe('keystone — the advisory pass PARKS (never lands) and surfaces honest recommendations', () => {
  it('PARKS-NEVER-PROMOTES: every accepted tier-2 candidate parks; champion never ratchets', () => {
    const { championStore, ledger, result } = runAdvisory()
    expect(result.summary.promoted).toBe(0) // the rail: no tier-2 candidate lands autonomously
    expect(result.summary.parked).toBeGreaterThan(0)
    expect(result.summary.parked).toBe(result.summary.accepted) // every accept parked
    expect(championStore.current()).toBe(ADVISORY_CHAMPION) // identity: the champion was never promoted away
    // The park ledger transition self-identifies its advisory provenance (doddy P2) — it can never be
    // mistaken for a real auto-loop park awaiting approval, even read outside its isolated ledger.
    const parkRationales = ledger
      .allEntries()
      .flatMap((e) => e.state_transitions)
      .filter((t) => t.to_state === 'parked')
      .map((t) => t.rationale)
    expect(parkRationales.length).toBeGreaterThan(0)
    expect(parkRationales.every((r) => r.includes('advisory exploration'))).toBe(true)
  })

  it('HONEST SURFACED: the honest companions become recommendations with a positive North-Star delta', () => {
    const { result } = runAdvisory()
    expect(result.recommendations.length).toBe(3) // autonomy 1,2,3 each consults honestly → each parks
    for (const rec of result.recommendations) {
      expect(rec.north_star_delta).toBeGreaterThan(0) // consulting genuinely beats the tier-1 base
      expect(rec.genome.parameters.autonomy_threshold).toBeDefined()
    }
    expect(result.frontierFullyExplored).toBe(true)
  })
})

describe('keystone — ISOLATION: the advisory pass cannot corrupt the real champion', () => {
  it('a separate (real) champion store is byte-identical untouched after an advisory run', () => {
    const realChampion: StrategyGenome = {
      genome_id: 'real_champ',
      parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 1, reminder_batching: 0 },
    }
    const realChampionStore = new ChampionStore(realChampion)
    const before = realChampionStore.currentHash()
    runAdvisory() // runs entirely on its OWN isolated stores
    expect(realChampionStore.current()).toBe(realChampion)
    expect(realChampionStore.currentHash()).toBe(before)
  })
})

describe('keystone — the FIREWALL protects the recommendation set (forged candidates are excluded)', () => {
  it('a vision_consult COST-suppress forge is VETOED → excluded from the recommendation set', () => {
    const { result } = runAdvisory({ planner: suppressVisionConsult })
    // The forge shaves the consult cost while holding vision at 1.0 — absent the firewall it would
    // out-rank every honest companion. The integrity gate vetoes it (a trusted session with no claim →
    // suppressed_effect), so the accept rule fails and it NEVER parks → the recommendation set is EMPTY.
    expect(result.recommendations.length).toBe(0)
    expect(result.summary.parked).toBe(0)
    expect(result.summary.promoted).toBe(0)
    expect(result.summary.rejected).toBeGreaterThan(0) // the forged candidates were rejected, not surfaced
  })

  it('the honest companions DO park — proving the veto targets the lie, not the model', () => {
    // Contrast with the forge arm above: identical wiring, honest planner → the same candidates park.
    const { result } = runAdvisory()
    expect(result.summary.parked).toBeGreaterThan(0)
  })
})

describe('keystone — the positive GUARD rule is load-bearing (the cost exclusion is not cosmetic)', () => {
  it('guarding couple_active_minutes_total (the double-count) rejects EVERY recommendation', () => {
    // The consult cost is already priced into the North-Star denominator. Adding it as a guard
    // double-counts: every tier-2 candidate "regresses" couple minutes vs the tier-1 base → rejected.
    const { result } = runAdvisory({
      guardMetrics: [...ADVISORY_GUARD_METRICS, 'couple_active_minutes_total'],
    })
    expect(result.recommendations.length).toBe(0)
    expect(result.summary.parked).toBe(0)
  })

  it('the positive rule (value metrics MINUS the cost) is exactly why recommendations exist', () => {
    const guarded = runAdvisory({ guardMetrics: [...ADVISORY_GUARD_METRICS, 'couple_active_minutes_total'] })
    const positive = runAdvisory() // value metrics only
    expect(guarded.result.recommendations.length).toBe(0)
    expect(positive.result.recommendations.length).toBeGreaterThan(0)
  })
})
