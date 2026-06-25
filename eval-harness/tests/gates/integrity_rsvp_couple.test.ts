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
 * Phase-4b Step 3: the integrity gate reconciles the RSVP-resolution numerator and the couple-attention
 * cost denominator — the two North-Star-hot metrics the escalation knob moves — against the trusted
 * record. These tests pin forge / mismatch / suppression for both effect-kinds, plus the completeness
 * invariant that the SPECIFIC fields the metrics read (rsvp_status, active_seconds) are diffed.
 */

function makeBuilder(): (eventName: string, payload: Record<string, unknown>) => EventEnvelope {
  const clock = new ManualClock('2027-01-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('seedRsvpIntegrity')
  return (eventName, payload) =>
    buildEvent(clock, ids, {
      event_name: eventName,
      trace_id: 'trace_1',
      wedding_id: 'wed_1',
      phase: 'rsvp_window',
      capability: 'rsvp',
      actor: 'guest',
      source: 'eval',
      payload,
      meta: { schema_version: '1.0.0' },
    })
}

function kinds(divs: readonly SelfReportDivergence[], effect: SelfReportDivergence['effect_kind']): SelfReportDivergence[] {
  return divs.filter((d) => d.effect_kind === effect)
}

describe('integrity — RSVP resolution reconciliation (the claimed numerator)', () => {
  it('passes when every claimed resolution matches a trusted outcome', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    recorder.recordRsvpOutcome({ guest_id: 'g1', rsvp_status: 'yes', resolved_via: 'reminder' })
    recorder.recordRsvpOutcome({ guest_id: 'g2', rsvp_status: 'no', resolved_via: 'couple' })
    const events = [
      emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g1', rsvp_status: 'yes' }),
      emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g2', rsvp_status: 'no' }),
    ]
    expect(checkIntegritySelfReportDivergence(events, recorder).passed).toBe(true)
  })

  it('VETOES a forged resolution: a claimed received with no trusted outcome (any cause-label)', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder() // never resolved g_never
    const events = [emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g_never', rsvp_status: 'yes' })]
    const divs = kinds(detectSelfReportDivergence(events, recorder), 'rsvp_resolution')
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(checkIntegritySelfReportDivergence(events, recorder).passed).toBe(false)
  })

  it('VETOES an rsvp_status mismatch (claimed yes, trusted no)', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    recorder.recordRsvpOutcome({ guest_id: 'g1', rsvp_status: 'no', resolved_via: 'reminder' })
    const events = [emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g1', rsvp_status: 'yes' })]
    const divs = kinds(detectSelfReportDivergence(events, recorder), 'rsvp_resolution')
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('rsvp_status')
  })

  it('detects a suppressed resolution (trusted outcome, no claim)', () => {
    const recorder = new TrustedRecorder()
    recorder.recordRsvpOutcome({ guest_id: 'g1', rsvp_status: 'yes', resolved_via: 'couple' })
    const divs = kinds(detectSelfReportDivergence([], recorder), 'rsvp_resolution')
    expect(divs[0]?.kind).toBe('suppressed_effect')
  })
})

describe('integrity — couple-session cost reconciliation (the claimed denominator)', () => {
  const trustedSession = (): TrustedRecorder => {
    const recorder = new TrustedRecorder()
    recorder.recordCoupleSession({ guest_id: 'g_relative', active_seconds: 600 })
    return recorder
  }

  it('passes when a claimed session matches the trusted cost', () => {
    const emit = makeBuilder()
    const events = [
      emit(EVENT_NAMES.couple_session_ended, { session_id: 'cs_1', about_guest_id: 'g_relative', active_seconds: 600 }),
    ]
    expect(checkIntegritySelfReportDivergence(events, trustedSession()).passed).toBe(true)
  })

  it('VETOES partial under-reporting of active_seconds (the real cost forge)', () => {
    const emit = makeBuilder()
    const events = [
      emit(EVENT_NAMES.couple_session_ended, { session_id: 'cs_1', about_guest_id: 'g_relative', active_seconds: 1 }),
    ]
    const divs = kinds(detectSelfReportDivergence(events, trustedSession()), 'couple_session')
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('active_seconds')
  })

  it('VETOES an absent active_seconds (skipWhenClaimAbsent:false — not a skip)', () => {
    const emit = makeBuilder()
    const events = [emit(EVENT_NAMES.couple_session_ended, { session_id: 'cs_1', about_guest_id: 'g_relative' })]
    const divs = kinds(detectSelfReportDivergence(events, trustedSession()), 'couple_session')
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('active_seconds')
  })

  it('VETOES a forged session (no trusted session) and one with no join key', () => {
    const emit = makeBuilder()
    const forged = [emit(EVENT_NAMES.couple_session_ended, { session_id: 'cs_x', about_guest_id: 'g_none', active_seconds: 600 })]
    expect(kinds(detectSelfReportDivergence(forged, trustedSession()), 'couple_session')[0]?.kind).toBe('forged_effect')

    const noKey = [emit(EVENT_NAMES.couple_session_ended, { session_id: 'cs_y', active_seconds: 600 })]
    const d = kinds(detectSelfReportDivergence(noKey, trustedSession()), 'couple_session')[0]
    expect(d?.kind).toBe('forged_effect')
    expect(d?.field).toBe('about_guest_id')
  })

  it('detects a suppressed couple session (trusted cost, no claim)', () => {
    const divs = kinds(detectSelfReportDivergence([], trustedSession()), 'couple_session')
    expect(divs[0]?.kind).toBe('suppressed_effect')
  })
})

describe('integrity — completeness invariant: the metric-read fields ARE diffed', () => {
  // The North Star reads rsvp_status (numerator) and active_seconds (denominator) off the claimed
  // stream. A self-consistent liar that shaves ONLY these fields must still be vetoed — proving each is
  // in the integrity diff (doddy P1-2). If a future edit drops either from the diff, this goes RED.
  it('a forge limited to rsvp_status AND active_seconds is still caught on both fields', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    recorder.recordRsvpOutcome({ guest_id: 'g1', rsvp_status: 'no', resolved_via: 'couple' })
    recorder.recordCoupleSession({ guest_id: 'g1', active_seconds: 600 })
    const events = [
      emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g1', rsvp_status: 'yes' }), // lies: yes vs no
      emit(EVENT_NAMES.couple_session_ended, { session_id: 'cs', about_guest_id: 'g1', active_seconds: 1 }), // lies: 1 vs 600
    ]
    const divs = detectSelfReportDivergence(events, recorder)
    const fields = new Set(divs.filter((d) => d.kind === 'field_mismatch').map((d) => d.field))
    expect(fields.has('rsvp_status')).toBe(true)
    expect(fields.has('active_seconds')).toBe(true)
  })
})

describe('integrity — sentiment reconciliation (the claimed guest_experience numerator, Phase 6)', () => {
  it('passes when every claimed sentiment sample matches the trusted observation', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    recorder.recordSentimentObservation({ guest_id: 'g1', sentiment_score: 0.75 })
    recorder.recordSentimentObservation({ guest_id: 'g2', sentiment_score: 1 })
    const events = [
      emit(EVENT_NAMES.guest_sentiment_sampled, { guest_id: 'g1', sentiment_score: 0.75 }),
      emit(EVENT_NAMES.guest_sentiment_sampled, { guest_id: 'g2', sentiment_score: 1 }),
    ]
    expect(checkIntegritySelfReportDivergence(events, recorder).passed).toBe(true)
  })

  it('VETOES an INFLATED sentiment_score (claimed 1.0, trusted 0.5) as a field_mismatch', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    recorder.recordSentimentObservation({ guest_id: 'g1', sentiment_score: 0.5 })
    const events = [emit(EVENT_NAMES.guest_sentiment_sampled, { guest_id: 'g1', sentiment_score: 1 })]
    const divs = kinds(detectSelfReportDivergence(events, recorder), 'guest_sentiment')
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('sentiment_score')
    expect(checkIntegritySelfReportDivergence(events, recorder).passed).toBe(false)
  })

  it('VETOES a FORGED sentiment sample for a guest with no trusted observation (phantom-happy guest)', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    const events = [emit(EVENT_NAMES.guest_sentiment_sampled, { guest_id: 'g_phantom', sentiment_score: 1 })]
    const divs = kinds(detectSelfReportDivergence(events, recorder), 'guest_sentiment')
    expect(divs[0]?.kind).toBe('forged_effect')
  })

  it('VETOES a SUPPRESSED sample (dropping an unhappy guest, which would raise the mean)', () => {
    const recorder = new TrustedRecorder()
    recorder.recordSentimentObservation({ guest_id: 'g_unhappy', sentiment_score: 0.25 })
    const divs = kinds(detectSelfReportDivergence([], recorder), 'guest_sentiment')
    expect(divs[0]?.kind).toBe('suppressed_effect')
  })

  it('VETOES a DUPLICATE sample for an already-observed guest (a mean re-weighting forge)', () => {
    // The metric means over EVERY emitted sample; re-emitting an honest HIGH score lifts the mean while
    // matching the trusted value on the field diff. The trusted record observed ONE sentiment per guest.
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    recorder.recordSentimentObservation({ guest_id: 'g_happy', sentiment_score: 1 })
    const events = [
      emit(EVENT_NAMES.guest_sentiment_sampled, { guest_id: 'g_happy', sentiment_score: 1 }),
      emit(EVENT_NAMES.guest_sentiment_sampled, { guest_id: 'g_happy', sentiment_score: 1 }), // duplicate
    ]
    const divs = kinds(detectSelfReportDivergence(events, recorder), 'guest_sentiment')
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(checkIntegritySelfReportDivergence(events, recorder).passed).toBe(false)
  })

  it('treats an ABSENT/non-numeric claimed score as a mismatch, not a skip (skipWhenClaimAbsent:false)', () => {
    const emit = makeBuilder()
    const recorder = new TrustedRecorder()
    recorder.recordSentimentObservation({ guest_id: 'g1', sentiment_score: 0.75 })
    const events = [emit(EVENT_NAMES.guest_sentiment_sampled, { guest_id: 'g1' })] // no sentiment_score
    const divs = kinds(detectSelfReportDivergence(events, recorder), 'guest_sentiment')
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('sentiment_score')
  })
})
