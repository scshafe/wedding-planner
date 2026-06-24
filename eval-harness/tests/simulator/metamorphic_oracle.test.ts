import {
  AGGREGATION_WEIGHTS,
  computeNorthStar,
  deriveNorthStarInputs,
  makePlannerSimulator,
  type ScenarioDefinition,
} from '@wedding-planner/eval-harness'
import { type EventEnvelope, genomeArtifactRef, type StrategyGenome } from '@wedding-planner/shared'
import { createMetricEngine } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import { makeGenome, makeGuest, makeScenario, refFor } from './simulator_fixtures'

/**
 * Step 4: the NON-CIRCULAR oracle for the planner simulator. The simulator authors the very events
 * the metrics read, so a test that asserts a hand-counted interior total ("3 received -> rate 2/3")
 * is tautological — it restates the simulator's own arithmetic and a sign-flipped model would pass it.
 *
 * These tests instead assert RELATIONS the domain fixes independently of the simulator's internals:
 *   - metamorphic monotonicity (more cadence must not LOWER resolution),
 *   - the anti-Goodhart guard tradeoff (pushing the target past comfort must LOWER the guard),
 *   - boundary fixed-points (already-resolved -> 1.0; no guests -> null, not 0),
 *   - anti-no-op (flipping only the genome param changes the stream AND moves the metric, correct sign).
 * None of them counts events by hand; each is a two-run relation or a domain-fixed boundary.
 */

const BASE_TS = '2027-03-01T12:00:00.000Z'
const engine = createMetricEngine()

/** Run the simulator at one cadence over a scenario and return (events, metric values). */
function runAt(cadence: number, scenario: ScenarioDefinition): {
  events: readonly EventEnvelope[]
  metric: (code: string) => number | null
} {
  const genome = makeGenome(cadence)
  const run = makePlannerSimulator({
    championGenome: genome,
    candidateGenome: genome,
    candidateArtifactRef: refFor(genome),
    baseTimestamp: BASE_TS,
  })
  const events = run(scenario, 'candidate').productEvents
  const computations = engine.computeMany(engine.metricCodes(), events, scenario.scenario_id)
  const byCode = new Map(computations.map((c) => [c.metric_code, c.value]))
  return { events, metric: (code) => byCode.get(code) ?? null }
}

const CADENCES = [0, 1, 2, 3]

describe('metamorphic — monotonicity & the guard tradeoff', () => {
  it('raising rsvp_reminder_cadence never DECREASES rsvp_resolution_rate', () => {
    const scenario = makeScenario('s_mono')
    const rates = CADENCES.map((c) => runAt(c, scenario).metric('rsvp_resolution_rate') ?? 0)
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1] as number)
    }
    // And it actually moves somewhere across the band (the relation isn't vacuously flat).
    expect(rates[rates.length - 1]).toBeGreaterThan(rates[0] as number)
  })

  it('pushing cadence past comfort RAISES resolution but LOWERS the guard (anti-Goodhart)', () => {
    const scenario = makeScenario('s_tradeoff')
    const low = runAt(1, scenario)
    const high = runAt(2, scenario)
    // Target up...
    expect(high.metric('rsvp_resolution_rate') as number).toBeGreaterThan(
      low.metric('rsvp_resolution_rate') as number,
    )
    // ...guard down. A simulator where cranking the cheap knob raised BOTH would be unrealistic and
    // would teach the loop a fake win; this relation is the thing that proves the tradeoff is real.
    expect(high.metric('guest_sentiment_score') as number).toBeLessThan(
      low.metric('guest_sentiment_score') as number,
    )
  })

  it('guest_sentiment_score is monotonically NON-INCREASING and STRICTLY moves across the band', () => {
    // NOTE (testineer Step-4): the strict drop here depends on DEFAULT_GUESTS containing an
    // unbounded-nag source (the never-responder + the slow guest crossing comfort). The strict
    // assertion is deliberate: if a future fixture edit flattens the guard, a non-increasing-only
    // check would pass vacuously (flat satisfies <=). Strict-movement fails that loudly.
    const scenario = makeScenario('s_guard_mono')
    const sentiments = CADENCES.map((c) => runAt(c, scenario).metric('guest_sentiment_score') ?? 1)
    for (let i = 1; i < sentiments.length; i += 1) {
      expect(sentiments[i]).toBeLessThanOrEqual(sentiments[i - 1] as number)
    }
    expect(sentiments[sentiments.length - 1]).toBeLessThan(sentiments[0] as number)
  })
})

describe('ANCHORED oracle — expected values reasoned from the latency labels, not read from the model', () => {
  it('resolves exactly the guests whose ground-truth latency is met (survives a sign-flip/off-by-one)', () => {
    // The monotonicity relations above are self-consistency checks (the model defines both the
    // behavior AND the direction). THIS is the real oracle: the numbers 0.5 and 1.0 are forced by the
    // MEANING of 'immediate' (resolves at 0 reminders) and 'after_one_reminder' (resolves at 1) —
    // reasoned by hand, hardcoded here, not derived from REMINDERS_NEEDED. A `cadence <= needed` or
    // `cadence + 1` mutation changes WHICH guest resolves at cadence 0 and fails this; the relations
    // would not catch it (testineer, Phase-2 Step-4 review).
    const scenario = makeScenario('s_anchor', [
      makeGuest('guest_immediate', 'immediate', 'yes'),
      makeGuest('guest_one', 'after_one_reminder', 'yes'),
    ])
    expect(runAt(0, scenario).metric('rsvp_resolution_rate')).toBe(0.5) // only the immediate guest
    expect(runAt(1, scenario).metric('rsvp_resolution_rate')).toBe(1.0) // both
  })

  it('a lone never-responder lands an anchored guard value (1 - 0.25*cadence)', () => {
    // Anchored on the guard side: a never-responder absorbs `cadence` reminders, each a nag against a
    // universal comfort ceiling of 0, so sentiment = 1 - SENTIMENT_PENALTY_PER_NAG*cadence. At cadence
    // 2 that is exactly 0.5. Hand-reasoned, not read from the model.
    const scenario = makeScenario('s_anchor_guard', [makeGuest('guest_never', 'never', 'maybe_needs_nudge')])
    expect(runAt(2, scenario).metric('guest_sentiment_score')).toBe(0.5)
    expect(runAt(0, scenario).metric('guest_sentiment_score')).toBe(1.0)
  })
})

describe('boundary fixed-points (domain truths no genome can change)', () => {
  it('an all-immediate-responder scenario resolves to 1.0 regardless of cadence', () => {
    const scenario = makeScenario('s_allimmediate', [
      makeGuest('guest_a', 'immediate'),
      makeGuest('guest_b', 'immediate', 'no'),
    ])
    for (const c of CADENCES) {
      expect(runAt(c, scenario).metric('rsvp_resolution_rate')).toBe(1)
    }
  })

  it('a no-guest scenario yields a null rate (honest-undefined), never 0', () => {
    const scenario = makeScenario('s_empty', [])
    expect(runAt(2, scenario).metric('rsvp_resolution_rate')).toBeNull()
  })
})

describe('property invariants over the genome band', () => {
  it('rsvp_resolution_rate stays in [0,1] (or null) for every cadence', () => {
    const scenario = makeScenario('s_invariant')
    for (const c of CADENCES) {
      const rate = runAt(c, scenario).metric('rsvp_resolution_rate')
      if (rate !== null) {
        expect(rate).toBeGreaterThanOrEqual(0)
        expect(rate).toBeLessThanOrEqual(1)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// PHASE 3 — the second knob (reminder_spacing) and the 2-D landscape oracle.
// ---------------------------------------------------------------------------------------------------

/** Run the simulator at a (cadence, spacing) genome over a scenario and return (events, metrics). */
function runCS(cadence: number, spacing: number, scenario: ScenarioDefinition): {
  events: readonly EventEnvelope[]
  metric: (code: string) => number | null
} {
  const genome = makeGenome(cadence, spacing)
  const run = makePlannerSimulator({
    championGenome: genome,
    candidateGenome: genome,
    candidateArtifactRef: refFor(genome),
    baseTimestamp: BASE_TS,
  })
  const events = run(scenario, 'candidate').productEvents
  const computations = engine.computeMany(engine.metricCodes(), events, scenario.scenario_id)
  const byCode = new Map(computations.map((c) => [c.metric_code, c.value]))
  return { events, metric: (code) => byCode.get(code) ?? null }
}

describe('ANCHORED oracle — reminder_spacing values reasoned by hand, not read from the model', () => {
  it('spacing softens each nag: a lone never-responder at cadence 2 lands 1 - penalty(spacing)*delivered', () => {
    // never-responder absorbs `delivered = min(cadence, capacity(spacing))` nags against a comfort
    // ceiling of 0. penalty(spacing) = 0.25*(1 - 0.25*spacing). Hand-reasoned, hardcoded:
    //   s0: delivered min(2,3)=2, penalty 0.25    -> 1 - 0.25*2  = 0.50
    //   s1: delivered min(2,3)=2, penalty 0.1875  -> 1 - 0.375   = 0.625
    //   s2: delivered min(2,1)=1, penalty 0.125   -> 1 - 0.125   = 0.875  (capacity dropped to 1)
    const scn = makeScenario('s_spacing_guard', [makeGuest('guest_never', 'never', 'maybe_needs_nudge')])
    expect(runCS(2, 0, scn).metric('guest_sentiment_score')).toBe(0.5)
    expect(runCS(2, 1, scn).metric('guest_sentiment_score')).toBe(0.625)
    expect(runCS(2, 2, scn).metric('guest_sentiment_score')).toBe(0.875)
  })

  it('spacing caps reach: a guest needing 2 reminders is un-resolved once capacity drops below 2', () => {
    // capacity(spacing) = [3,3,1,0][spacing]. The after_multiple_reminders guest needs 2 reminders.
    // At cadence 2: delivered = min(2, capacity). s0/s1 (capacity 3) deliver 2 -> resolved; s2
    // (capacity 1) delivers 1 < 2 -> NOT resolved. So spacing trades reach for comfort (the downside).
    const scn = makeScenario('s_spacing_reach', [
      makeGuest('guest_immediate', 'immediate', 'yes'),
      makeGuest('guest_many', 'after_multiple_reminders', 'yes'),
    ])
    expect(runCS(2, 1, scn).metric('rsvp_resolution_rate')).toBe(1.0) // both resolved
    expect(runCS(2, 2, scn).metric('rsvp_resolution_rate')).toBe(0.5) // only the immediate guest
  })
})

describe('anti-no-op — flipping ONLY reminder_spacing changes the stream AND moves a metric', () => {
  it('at a fixed cadence, raising spacing changes the events and RAISES guest_sentiment_score', () => {
    // The dual of the cadence anti-no-op: a simulator that ignored reminder_spacing would pass
    // determinism + plumbing then never explore the 2nd dimension. Pair (s0,s1) at cadence 2: same
    // delivery (capacity 3 at both) but softer nags at s1, so sentiment strictly rises and the stream
    // differs (fewer? no — same events, but sentiment payload differs), so compare metric + payload.
    const scn = makeScenario('s_spacing_antinoop')
    const a = runCS(2, 0, scn)
    const b = runCS(2, 1, scn)
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events))
    expect(b.metric('guest_sentiment_score') as number).toBeGreaterThan(
      a.metric('guest_sentiment_score') as number,
    )
  })
})

// The keystone corpus (same guest mix as the loop keystone): one immediate, one one-reminder, one
// multi-reminder no-show, one never-responder, over a golden + an adversarial scenario.
const KEYSTONE_GUESTS = [
  makeGuest('guest_immediate', 'immediate', 'yes'),
  makeGuest('guest_one', 'after_one_reminder', 'yes'),
  makeGuest('guest_many', 'after_multiple_reminders', 'no'),
  makeGuest('guest_never', 'never', 'maybe_needs_nudge'),
]
const KEYSTONE_CORPUS: readonly ScenarioDefinition[] = [
  makeScenario('golden_g', KEYSTONE_GUESTS, 'golden'),
  makeScenario('adv_a', KEYSTONE_GUESTS, 'adversarial'),
]

/** The aggregate North Star a genome scores over a corpus (the value the accept rule compares). */
function aggregateNorthStar(cadence: number, spacing: number): number {
  const genome: StrategyGenome = makeGenome(cadence, spacing)
  let weighted = 0
  let totalWeight = 0
  for (const scenario of KEYSTONE_CORPUS) {
    const run = makePlannerSimulator({
      championGenome: genome,
      candidateGenome: genome,
      candidateArtifactRef: genomeArtifactRef(genome),
      baseTimestamp: BASE_TS,
    })
    const events = run(scenario, 'candidate').productEvents
    const comps = engine.computeMany(engine.metricCodes(), events, scenario.scenario_id)
    const mv: Record<string, number | null> = {}
    for (const c of comps) mv[c.metric_code] = c.value
    const ratio = computeNorthStar(deriveNorthStarInputs(mv, scenario.couple), false).ratio
    const weight = AGGREGATION_WEIGHTS[scenario.scenario_type as keyof typeof AGGREGATION_WEIGHTS] ?? 1
    weighted += weight * ratio
    totalWeight += weight
  }
  return weighted / totalWeight
}

function matrix(): number[][] {
  return [0, 1, 2, 3].map((c) => [0, 1, 2, 3].map((s) => Number(aggregateNorthStar(c, s).toFixed(4))))
}

/** The argmax cadence at a fixed spacing column (lowest cadence on a tie). */
function argmaxCadence(m: number[][], spacing: number): number {
  let best = 0
  for (let c = 1; c <= 3; c += 1) if ((m[c]?.[spacing] ?? -1) > (m[best]?.[spacing] ?? -1)) best = c
  return best
}

describe('the 2-D North-Star matrix — pinned, with a STRICT interior optimum', () => {
  // Pinned so model/constant drift is loud at CI time rather than silently moving the optimum.
  const EXPECTED: number[][] = [
    [0.5625, 0.5625, 0.5625, 0.5625], // cadence 0
    [0.6823, 0.6888, 0.6953, 0.5625], // cadence 1
    [0.776, 0.7956, 0.6953, 0.5625], // cadence 2
    [0.75, 0.776, 0.6953, 0.5625], // cadence 3
  ]

  it('matches the pinned aggregate North-Star matrix over the keystone corpus', () => {
    expect(matrix()).toEqual(EXPECTED)
  })

  it('has a UNIQUE, STRICT, INTERIOR optimum at (cadence 2, spacing 1)', () => {
    const m = matrix()
    const G = { c: 2, s: 1 }
    const gVal = m[G.c]?.[G.s] as number
    // Interior on BOTH axes (not a face/corner).
    expect(G.c).toBeGreaterThan(0)
    expect(G.c).toBeLessThan(3)
    expect(G.s).toBeGreaterThan(0)
    expect(G.s).toBeLessThan(3)
    // Strictly beats ALL in-box axis AND diagonal neighbors (rules out a corner-in-disguise).
    for (const dc of [-1, 0, 1]) {
      for (const ds of [-1, 0, 1]) {
        if (dc === 0 && ds === 0) continue
        const nc = G.c + dc
        const ns = G.s + ds
        const neighbor = m[nc]?.[ns]
        if (neighbor !== undefined) {
          expect(gVal, `(${nc},${ns}) must be < optimum`).toBeGreaterThan(neighbor)
        }
      }
    }
    // It is the global argmax of the whole box.
    const flat = m.flat()
    expect(Math.max(...flat)).toBe(gVal)
    expect(flat.filter((v) => v === gVal).length).toBe(1) // unique
  })

  it('is NON-SEPARABLE: the optimal cadence depends on the spacing', () => {
    // argmax over cadence is 2 at spacing 1 but drops once capacity caps reach (spacing 2 -> capacity
    // 1, so cadence >1 buys nothing and the cheapest cadence wins). A separable landscape would have a
    // spacing-independent best cadence. This is the property a coordinate-by-coordinate intuition misses.
    const m = matrix()
    expect(argmaxCadence(m, 1)).toBe(2)
    expect(argmaxCadence(m, 2)).toBeLessThan(2)
  })

  it('REQUIRES the second knob: the box optimum strictly beats every cadence-only (spacing 0) point', () => {
    // The pre-Phase-3 search could only move cadence (spacing pinned at the seed's 0). The true optimum
    // lives at spacing 1, so any spacing-0-locked search is strictly suboptimal — the formal reason the
    // search MUST explore the second dimension (the keystone proves the loop-level version of this).
    const m = matrix()
    const boxOptimum = Math.max(...m.flat())
    const bestAtSpacing0 = Math.max(...m.map((row) => row[0] as number))
    expect(boxOptimum).toBeGreaterThan(bestAtSpacing0)
  })

  it('the interior optimum has a finite margin over its neighbours (not a knife-edge)', () => {
    // A robustness proxy without constant-injection: the smallest gap to a neighbour is ~0.0196
    // (the optimum 0.7956 over (c2,s0)=(c3,s1)=0.776). A non-trivial margin means small constant
    // perturbations keep the optimum interior; the exact band is documented in stage_a_planner.
    const m = matrix()
    const gVal = m[2]?.[1] as number
    const neighbours = [m[1]?.[1], m[3]?.[1], m[2]?.[0], m[2]?.[2]].filter((v): v is number => v !== undefined)
    const smallestMargin = Math.min(...neighbours.map((v) => gVal - v))
    expect(smallestMargin).toBeGreaterThan(0.01)
  })
})

describe('anti-no-op — the dual of the determinism test (catches a candidate-blind simulator)', () => {
  it('flipping ONLY rsvp_reminder_cadence changes the event stream AND moves the metric (correct sign)', () => {
    // A simulator that ignored the genome would pass determinism, the oracle relations vacuously, and
    // every plumbing test — then converge to the champion forever, looking like "search dry". This is
    // the one tripwire for that: different input MUST produce different output.
    // Pair (1,2) is chosen because rsvp_resolution_rate strictly increases there on DEFAULT_GUESTS
    // (0.50 -> 0.75); the (2,3) segment is intentionally FLAT (the never-responder never resolves), so
    // do not "simplify" this to (2,3) — the strict delta below would break for a reason unrelated to a
    // no-op (testineer Step-4 brittleness note).
    const scenario = makeScenario('s_antinoop')
    const a = runAt(1, scenario)
    const b = runAt(2, scenario)
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events))
    expect(b.metric('rsvp_resolution_rate') as number).toBeGreaterThan(
      a.metric('rsvp_resolution_rate') as number,
    )
  })
})
