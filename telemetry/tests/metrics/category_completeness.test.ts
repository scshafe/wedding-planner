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

  it('reads ONLY category_id + booking_status — the `category` provenance value is not load-bearing (doddy P2-1)', () => {
    // The metric must not depend on `category`; if a future grader ever reads it, it becomes an
    // un-diffed relabel field. Pin the load-bearing field set: same ids/statuses, different `category`
    // strings (and no requires_couple_approval claimed at all) → identical rate.
    const a = stream([
      { category_id: 'c1', category: 'venue', booking_status: 'booked' },
      { category_id: 'c2', category: 'catering', booking_status: 'deferred' },
    ])
    const b = stream([
      { category_id: 'c1', category: 'WILDLY_DIFFERENT', booking_status: 'booked' },
      { category_id: 'c2', category: 'also_different', booking_status: 'deferred', requires_couple_approval: false },
    ])
    expect(cat(a).value).toBe(0.5)
    expect(cat(b).value).toBe(0.5)
  })

  it('a DUPLICATE booked claim DOES inflate the rate — so the gate duplicate-guard is the sole stopper (doddy P2-3)', () => {
    // honest {booked, deferred} = 1/2; re-emitting the booked claim → {booked, booked, deferred} = 2/3.
    // The metric has no dedup by design (mirrors sentiment/Q&A); the integrity gate's duplicate→forged arm
    // is what vetoes this, pinned in integrity_category.test.ts. This test pins that the lift is real.
    const events = stream([
      { category_id: 'c1', category: 'invitations', booking_status: 'booked' },
      { category_id: 'c1', category: 'invitations', booking_status: 'booked' }, // duplicate
      { category_id: 'c2', category: 'venue', booking_status: 'deferred' },
    ])
    expect(cat(events).value).toBeCloseTo(2 / 3, 10)
  })
})
