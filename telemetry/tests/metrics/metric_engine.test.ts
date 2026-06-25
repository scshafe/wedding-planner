import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import { buildSampleEventStream } from '../fixtures/sample_event_stream'

const START = '2027-01-02T15:00:00.000Z'
const WEDDING = 'wed_1'
const ALL_CODES = [
  METRIC_CODES.couple_active_minutes_total,
  METRIC_CODES.autonomy_rate,
  METRIC_CODES.decision_reversal_rate,
  METRIC_CODES.rsvp_resolution_rate,
  METRIC_CODES.guest_sentiment_score,
  METRIC_CODES.boundary_hold_rate,
  METRIC_CODES.budget_variance_pct,
]

function freshStream(): ReturnType<typeof buildSampleEventStream> {
  return buildSampleEventStream(new ManualClock(START), new SequentialIdGenerator('seedA'), WEDDING)
}

describe('metric engine — determinism and replayability', () => {
  it('builds byte-identical streams from freshly seeded clock + id generator', () => {
    // If buildEvent read an ambient clock/RNG, these two would differ.
    expect(freshStream()).toEqual(freshStream())
  })

  it('produces identical metric results across two replays of the same stream', () => {
    const engine = createMetricEngine()
    const first = engine.computeMany(ALL_CODES, freshStream(), WEDDING)
    const second = engine.computeMany(ALL_CODES, freshStream(), WEDDING)
    expect(first).toEqual(second)
  })

  it('is stateless: recomputing over the same stream yields the same result', () => {
    const engine = createMetricEngine()
    const stream = freshStream()
    expect(engine.computeMany(ALL_CODES, stream, WEDDING)).toEqual(
      engine.computeMany(ALL_CODES, stream, WEDDING),
    )
  })
})

describe('metric engine — correctness on a known stream', () => {
  const engine = createMetricEngine()
  const stream = freshStream()
  const valueOf = (code: string): number | null => engine.compute(code, stream, WEDDING).value

  it('couple_active_minutes_total sums session active_seconds / 60', () => {
    expect(valueOf(METRIC_CODES.couple_active_minutes_total)).toBe(50)
  })

  it('autonomy_rate = autonomous / (autonomous + requested)', () => {
    expect(valueOf(METRIC_CODES.autonomy_rate)).toBe(0.75)
  })

  it('decision_reversal_rate = reversed / (made + autonomous)', () => {
    expect(valueOf(METRIC_CODES.decision_reversal_rate)).toBeCloseTo(0.2, 10)
  })

  it('rsvp_resolution_rate = resolved-among-requested / requested', () => {
    expect(valueOf(METRIC_CODES.rsvp_resolution_rate)).toBeCloseTo(2 / 3, 10)
  })

  it('guest_sentiment_score is the mean of sampled scores', () => {
    expect(valueOf(METRIC_CODES.guest_sentiment_score)).toBeCloseTo(0.7, 10)
  })

  it('boundary_hold_rate = held / tested', () => {
    expect(valueOf(METRIC_CODES.boundary_hold_rate)).toBe(0.5)
  })

  it('budget_variance_pct = (spend - budget) / budget * 100', () => {
    expect(valueOf(METRIC_CODES.budget_variance_pct)).toBeCloseTo(5, 10)
  })
})

describe('metric engine — scoping and edge cases', () => {
  const engine = createMetricEngine()

  it('ignores events from other weddings (groups by wedding_id)', () => {
    const stream = freshStream()
    // The same stream queried under a different wedding_id sees no events.
    expect(engine.compute(METRIC_CODES.couple_active_minutes_total, stream, 'other').value).toBe(0)
    expect(engine.compute(METRIC_CODES.boundary_hold_rate, stream, 'other').value).toBeNull()
  })

  it('returns null (not a fabricated number) for a rate with an empty denominator', () => {
    const result = engine.compute(METRIC_CODES.rsvp_resolution_rate, [], WEDDING)
    expect(result.value).toBeNull()
    expect(result.support).toMatchObject({ denominator: 0 })
  })

  it('throws a coded error for an unregistered metric code', () => {
    expect(() => engine.compute('not_a_metric', freshStream(), WEDDING)).toThrowError(
      /TELEMETRY.METRIC_NOT_REGISTERED|not_a_metric/,
    )
  })

  it('does NOT crash on a malformed active_seconds — it contributes 0 (Phase 10, doddy P2)', () => {
    // offline_scorer runs metrics UNCONDITIONALLY, even on a stream the integrity gate vetoes. A
    // couple.session.ended with absent/NaN active_seconds must degrade the cost metric conservatively
    // (0-minute contribution), never throw and crash scoring of the run. The gate still vetoes the
    // malformed session via its own raw read (skipWhenClaimAbsent:false) — this only removes the DoS.
    const clock = new ManualClock(START)
    const ids = new SequentialIdGenerator('seedMalformed')
    const session = (payload: Record<string, unknown>): ReturnType<typeof buildEvent> =>
      buildEvent(clock, ids, {
        event_name: EVENT_NAMES.couple_session_ended,
        trace_id: 't', wedding_id: WEDDING, phase: 'booking', capability: 'orchestration',
        actor: 'couple', source: 'eval', payload, meta: { schema_version: '1.0.0' },
      })
    const stream = [
      session({ session_id: 'cs_ok', active_seconds: 600 }),
      session({ session_id: 'cs_absent' }), // no active_seconds → 0
      session({ session_id: 'cs_nan', active_seconds: Number.NaN }), // NaN → 0
    ]
    expect(() => engine.compute(METRIC_CODES.couple_active_minutes_total, stream, WEDDING)).not.toThrow()
    expect(engine.compute(METRIC_CODES.couple_active_minutes_total, stream, WEDDING).value).toBe(10) // 600s only
  })
})
