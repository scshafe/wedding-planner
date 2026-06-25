import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Phase-8 Step 3: `category_completeness_rate` over the CLAIMED `category.booked` stream. A category is
 * complete iff `booking_status === 'booked'`. Denominator is CLAIMS-ONLY (claims with a valid
 * `category_id`); a missing/invalid status counts as incomplete (conservative); an id-less claim is
 * skipped (no trusted match to inflate the rate); no categories handled → null.
 */

const WEDDING = 'wed_cat'

function bookedEvent(
  clock: ManualClock,
  ids: SequentialIdGenerator,
  payload: Record<string, unknown>,
): ReturnType<typeof buildEvent> {
  const event = buildEvent(clock, ids, {
    event_name: EVENT_NAMES.category_booked,
    trace_id: 't_cat',
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
  const clock = new ManualClock('2027-01-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('cat')
  return payloads.map((p) => bookedEvent(clock, ids, p))
}

const engine = createMetricEngine()
const cat = (
  events: ReturnType<typeof buildEvent>[],
): { value: number | null; support: Record<string, number> } => {
  const c = engine.compute(METRIC_CODES.category_completeness_rate, events, WEDDING)
  return { value: c.value, support: c.support as Record<string, number> }
}

describe('category_completeness_rate — completeness over the claimed stream', () => {
  it('counts a category with booking_status=booked as complete', () => {
    const events = stream([
      { category_id: 'c1', category: 'venue', booking_status: 'booked' },
      { category_id: 'c2', category: 'catering', booking_status: 'booked' },
    ])
    expect(cat(events).value).toBe(1)
  })

  it('a mixed booked/deferred stream yields the right ratio (claims-only denominator)', () => {
    const events = stream([
      { category_id: 'c1', category: 'invitations', booking_status: 'booked' },
      { category_id: 'c2', category: 'venue', booking_status: 'deferred' }, // approval-required, tier-1 defers
    ])
    const r = cat(events)
    expect(r.value).toBe(0.5)
    expect(r.support).toMatchObject({ booked: 1, handled: 2, denominator: 2 })
  })

  it('a missing/invalid booking_status counts as INCOMPLETE (conservative)', () => {
    const events = stream([
      { category_id: 'c1', category: 'venue' }, // no booking_status
      { category_id: 'c2', category: 'catering', booking_status: 'Booked' }, // wrong-case enum → null
      { category_id: 'c3', category: 'music', booking_status: 'booked' }, // complete
    ])
    expect(cat(events).value).toBeCloseTo(1 / 3, 10)
  })

  it('an id-less claim is SKIPPED (not counted), never crashes scoring', () => {
    const events = stream([
      { category: 'venue', booking_status: 'booked' }, // no category_id
      { category_id: 'c2', category: 'catering', booking_status: 'booked' },
    ])
    const r = cat(events)
    expect(r.value).toBe(1) // only the well-formed claim counts
    expect(r.support).toMatchObject({ handled: 1 })
  })

  it('no category events → null (honest-undefined), never 0 — this is the search corpus', () => {
    expect(cat([]).value).toBeNull()
  })
})
