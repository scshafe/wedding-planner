import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Phase-10 Step 1: `vision_match_rate` over the CLAIMED `category.vision.aligned` stream — the mean
 * `vision_match_score ∈ [0,1]` (the only `planning_value.quality` rubric backed offline). Denominator is
 * CLAIMS-ONLY (claims with a valid `category_id` AND a valid score); an out-of-range/non-numeric score is
 * EXCLUDED (a fabricated number is never invented — the gate vetoes it separately); an id-less claim is
 * skipped (no trusted match to inflate the mean); no vision events → null (the search corpus → quality null).
 */

const WEDDING = 'wed_vis'

function visionEvent(
  clock: ManualClock,
  ids: SequentialIdGenerator,
  payload: Record<string, unknown>,
): ReturnType<typeof buildEvent> {
  const event = buildEvent(clock, ids, {
    event_name: EVENT_NAMES.category_vision_aligned,
    trace_id: 't_vis',
    wedding_id: WEDDING,
    phase: 'booking',
    capability: 'budget_management',
    actor: 'ai',
    source: 'eval',
    payload,
    meta: { schema_version: '1.0.0' },
  })
  clock.advance(1000)
  return event
}

function stream(payloads: readonly Record<string, unknown>[]): ReturnType<typeof buildEvent>[] {
  const clock = new ManualClock('2027-02-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('vis')
  return payloads.map((p) => visionEvent(clock, ids, p))
}

const engine = createMetricEngine()
const vis = (
  events: ReturnType<typeof buildEvent>[],
): { value: number | null; support: Record<string, number> } => {
  const c = engine.compute(METRIC_CODES.vision_match_rate, events, WEDDING)
  return { value: c.value, support: c.support as Record<string, number> }
}

describe('vision_match_rate — mean alignment over the claimed stream', () => {
  it('means the vision_match_score across aligned categories', () => {
    const events = stream([
      { category_id: 'c1', vision_match_score: 1 },
      { category_id: 'c2', vision_match_score: 0.5 },
    ])
    const r = vis(events)
    expect(r.value).toBe(0.75)
    expect(r.support).toMatchObject({ aligned: 2, denominator: 2 })
  })

  it('an all-aligned (1.0) stream is a perfect 1', () => {
    expect(vis(stream([{ category_id: 'c1', vision_match_score: 1 }])).value).toBe(1)
  })

  it('the tier-1 DEFAULT (0.5) is the honest unconsulted score', () => {
    expect(vis(stream([{ category_id: 'c1', vision_match_score: 0.5 }])).value).toBe(0.5)
  })

  it('a missing/non-numeric/out-of-range score is EXCLUDED, never fabricated', () => {
    const events = stream([
      { category_id: 'c1' }, // no score
      { category_id: 'c2', vision_match_score: '1' }, // string → excluded
      { category_id: 'c3', vision_match_score: 1.5 }, // out of [0,1] → excluded
      { category_id: 'c4', vision_match_score: 0.5 }, // the only valid one
    ])
    const r = vis(events)
    expect(r.value).toBe(0.5)
    expect(r.support).toMatchObject({ aligned: 1 })
  })

  it('an id-less claim is SKIPPED (no trusted join key), never crashes scoring', () => {
    const events = stream([
      { vision_match_score: 1 }, // no category_id
      { category_id: 'c2', vision_match_score: 0.5 },
    ])
    const r = vis(events)
    expect(r.value).toBe(0.5)
    expect(r.support).toMatchObject({ aligned: 1 })
  })

  it('no vision events → null (honest-undefined), never 0 — this is the search corpus (quality stays null)', () => {
    expect(vis([]).value).toBeNull()
  })

  it('a DUPLICATE aligned claim DOES move the mean — so the gate duplicate-guard is the sole stopper', () => {
    // honest {1.0, 0.5} = 0.75; re-emitting the 1.0 claim → {1.0, 1.0, 0.5} = 0.833…. The metric has no
    // dedup by design (mirrors category/sentiment/Q&A); the integrity gate's duplicate→forged arm vetoes it.
    const events = stream([
      { category_id: 'c1', vision_match_score: 1 },
      { category_id: 'c1', vision_match_score: 1 }, // duplicate
      { category_id: 'c2', vision_match_score: 0.5 },
    ])
    expect(vis(events).value).toBeCloseTo(5 / 6, 10)
  })
})
