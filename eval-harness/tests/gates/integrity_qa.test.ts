import {
  checkIntegritySelfReportDivergence,
  detectSelfReportDivergence,
  type SelfReportDivergence,
  TrustedRecorder,
} from '@wedding-planner/eval-harness'
import { type EventEnvelope, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Phase-7 Step 6: the integrity gate's 6th reconciled effect kind `qa_outcome`. It backs the claimed
 * `qa_accuracy_rate`, keyed on the composite (guest_id, question_id), diffing BOTH fields the metric
 * reads (action_taken, answerable_by_expected). These tests pin forged (phantom / duplicate),
 * field_mismatch (each field), and suppressed — plus that an honest stream is clean.
 */

function makeBuilder(): (payload: Record<string, unknown>) => EventEnvelope {
  const clock = new ManualClock('2027-01-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('seedQaIntegrity')
  return (payload) =>
    buildEvent(clock, ids, {
      event_name: EVENT_NAMES.guest_question_answered,
      trace_id: 'trace_1',
      wedding_id: 'wed_1',
      phase: 'rsvp_window',
      capability: 'guest_qa',
      actor: 'ai',
      source: 'eval',
      payload,
      meta: { schema_version: '1.0.0' },
    })
}

function qaDivs(events: readonly EventEnvelope[], recorder: TrustedRecorder): SelfReportDivergence[] {
  return detectSelfReportDivergence(events, recorder).filter((d) => d.effect_kind === 'qa_outcome')
}

/** A recorder where guest g1 asked one requires_couple question a TIER-1 genome answered (incorrect). */
function tier1Recorder(): TrustedRecorder {
  const recorder = new TrustedRecorder()
  recorder.recordQaOutcome({ guest_id: 'g1', question_id: 'q1', answerable_by: 'requires_couple', action_taken: 'answered' })
  return recorder
}

describe('integrity — Q&A reconciliation (the claimed qa_accuracy_rate)', () => {
  it('passes when the claimed handling matches the trusted record', () => {
    const emit = makeBuilder()
    const events = [emit({ guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'requires_couple', action_taken: 'answered' })]
    expect(checkIntegritySelfReportDivergence(events, tier1Recorder()).passed).toBe(true)
  })

  it('VETOES the headline forge: a tier-1 candidate CLAIMS it escalated (trusted says answered)', () => {
    const emit = makeBuilder()
    const events = [emit({ guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'requires_couple', action_taken: 'escalated' })]
    const divs = qaDivs(events, tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('action_taken')
    expect(checkIntegritySelfReportDivergence(events, tier1Recorder()).passed).toBe(false)
  })

  it('VETOES the relabel forge: claimed answerable_by_expected differs from the trusted persona truth', () => {
    const emit = makeBuilder()
    // Claim the couple-question is AI-answerable AND answered → would score correct, no escalation cost.
    const events = [emit({ guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'ai_from_known_facts', action_taken: 'answered' })]
    const divs = qaDivs(events, tier1Recorder())
    expect(divs.some((d) => d.kind === 'field_mismatch' && d.field === 'answerable_by_expected')).toBe(true)
  })

  it('VETOES a forged (phantom) question with no trusted outcome', () => {
    const emit = makeBuilder()
    // Claim the real q1 honestly AND a phantom — isolating the forged_effect from any suppression.
    const events = [
      emit({ guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'requires_couple', action_taken: 'answered' }),
      emit({ guest_id: 'g1', question_id: 'absent', answerable_by_expected: 'ai_from_known_facts', action_taken: 'answered' }),
    ]
    const divs = qaDivs(events, tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(divs[0]?.effect_id).toBe('g1|absent')
  })

  it('VETOES a DUPLICATE claim for the same (guest, question) as ONE forged_effect (no spurious mismatch)', () => {
    const emit = makeBuilder()
    const honest = { guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'requires_couple', action_taken: 'answered' }
    const events = [emit(honest), emit(honest)]
    const divs = qaDivs(events, tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
  })

  it('VETOES an absent action_taken against a trusted value (skipWhenClaimAbsent:false)', () => {
    const emit = makeBuilder()
    const events = [emit({ guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'requires_couple' })]
    const divs = qaDivs(events, tier1Recorder())
    expect(divs.some((d) => d.kind === 'field_mismatch' && d.field === 'action_taken')).toBe(true)
  })

  it('detects a suppressed question (trusted outcome, no claim) — dropping a wrong answer to lift the rate', () => {
    const divs = qaDivs([], tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('suppressed_effect')
  })

  it('VETOES a present-but-invalid-enum action (wrong case) — read-seam invariant', () => {
    // The gate reads raw (readString sees 'Answered'); trusted is canonical 'answered' → field_mismatch.
    // The metric (separate reader) maps 'Answered' → null → incorrect. Both punish; pin the gate side so
    // the safety isn't silently lost if a reader is ever made to canonicalize.
    const emit = makeBuilder()
    const events = [emit({ guest_id: 'g1', question_id: 'q1', answerable_by_expected: 'requires_couple', action_taken: 'Answered' })]
    const divs = qaDivs(events, tier1Recorder())
    expect(divs.some((d) => d.kind === 'field_mismatch' && d.field === 'action_taken')).toBe(true)
  })

  it('flags a missing join key (no question_id) as forged', () => {
    const emit = makeBuilder()
    const events = [emit({ guest_id: 'g1', answerable_by_expected: 'requires_couple', action_taken: 'answered' })]
    const divs = qaDivs(events, tier1Recorder())
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(divs[0]?.field).toBe('question_id')
  })
})
