import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Phase-7 Step 3: `qa_accuracy_rate` over the CLAIMED `guest.question.answered` stream. An answer is
 * correct iff `action_taken` matches the required action for `answerable_by_expected`
 * (ai→answered, requires_couple→escalated, must_refuse→refused). Denominator is CLAIMS-ONLY; a
 * missing/invalid field counts as incorrect (conservative); no answers → null.
 */

const WEDDING = 'wed_qa'

function answeredEvent(
  clock: ManualClock,
  ids: SequentialIdGenerator,
  payload: Record<string, unknown>,
): ReturnType<typeof buildEvent> {
  const event = buildEvent(clock, ids, {
    event_name: EVENT_NAMES.guest_question_answered,
    trace_id: 't_qa',
    wedding_id: WEDDING,
    phase: 'rsvp_window',
    capability: 'guest_qa',
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
  const ids = new SequentialIdGenerator('qa')
  return payloads.map((p) => answeredEvent(clock, ids, p))
}

const engine = createMetricEngine()
const qa = (events: ReturnType<typeof buildEvent>[]): { value: number | null; support: Record<string, number> } => {
  const c = engine.compute(METRIC_CODES.qa_accuracy_rate, events, WEDDING)
  return { value: c.value, support: c.support as Record<string, number> }
}

describe('qa_accuracy_rate — correctness over the claimed stream', () => {
  it('counts an action that matches the required action for its answerable_by as correct', () => {
    const events = stream([
      { guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'ai_from_known_facts', action_taken: 'answered' },
      { guest_id: 'g1', question_id: 'q2', answerable_by_expected: 'requires_couple', action_taken: 'escalated' },
      { guest_id: 'g2', question_id: 'q1', answerable_by_expected: 'must_refuse', action_taken: 'refused' },
    ])
    expect(qa(events).value).toBe(1)
  })

  it('a mixed stream yields the right ratio (claims-only denominator)', () => {
    const events = stream([
      { guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'ai_from_known_facts', action_taken: 'answered' }, // correct
      { guest_id: 'g1', question_id: 'q2', answerable_by_expected: 'requires_couple', action_taken: 'answered' }, // WRONG (should escalate)
    ])
    const r = qa(events)
    expect(r.value).toBe(0.5)
    expect(r.support).toMatchObject({ correct: 1, answered: 2, denominator: 2 })
  })

  it('a missing/invalid action or answerable_by counts as INCORRECT (conservative)', () => {
    const events = stream([
      { guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'ai_from_known_facts' }, // no action_taken
      { guest_id: 'g1', question_id: 'q2', action_taken: 'answered' }, // no answerable_by_expected
      { guest_id: 'g1', question_id: 'q3', answerable_by_expected: 'ai_from_known_facts', action_taken: 'answered' }, // correct
    ])
    const r = qa(events)
    expect(r.value).toBeCloseTo(1 / 3, 10)
  })

  it('a present-but-invalid-enum action (wrong case) is scored INCORRECT, not crashed', () => {
    // Read-seam invariant (doddy): the metric maps a non-enum action to null → incorrect. The integrity
    // gate (raw readString) sees 'Answered' ≠ trusted 'answered' → veto. Both punish; pin the metric side.
    const events = stream([
      { guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'ai_from_known_facts', action_taken: 'Answered' },
    ])
    expect(qa(events).value).toBe(0)
  })

  it('an id-less answer is SKIPPED (not counted), never crashes scoring', () => {
    const events = stream([
      { question_id: 'q1', answerable_by_expected: 'ai_from_known_facts', action_taken: 'answered' }, // no guest_id
      { guest_id: 'g1', question_id: 'q2', answerable_by_expected: 'ai_from_known_facts', action_taken: 'answered' },
    ])
    const r = qa(events)
    expect(r.value).toBe(1) // only the well-formed answer counts
    expect(r.support).toMatchObject({ answered: 1 })
  })

  it('no answered events → null (honest-undefined), never 0', () => {
    expect(qa([]).value).toBeNull()
  })
})
