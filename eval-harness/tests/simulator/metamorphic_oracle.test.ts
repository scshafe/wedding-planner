import { makePlannerSimulator, type ScenarioDefinition } from '@wedding-planner/eval-harness'
import { type EventEnvelope } from '@wedding-planner/shared'
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
