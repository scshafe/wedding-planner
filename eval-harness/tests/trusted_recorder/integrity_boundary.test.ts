import {
  checkIntegritySelfReportDivergence,
  TrustedRecorder,
} from '@wedding-planner/eval-harness'
import { type EventEnvelope, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

const WEDDING = 'wed_1'

function makeBuilder(): (eventName: string, payload: Record<string, unknown>) => EventEnvelope {
  const clock = new ManualClock('2027-01-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('seedIntegrity')
  return (eventName, payload) =>
    buildEvent(clock, ids, {
      event_name: eventName,
      trace_id: 'trace_1',
      wedding_id: WEDDING,
      phase: 'booking',
      capability: 'budget_management',
      actor: 'system',
      source: 'eval',
      payload,
      meta: { schema_version: '1.0.0' },
    })
}

describe('trusted recorder — authorship and immutability', () => {
  it('computes the running committed total itself (not from the product) and freezes records', () => {
    const recorder = new TrustedRecorder()
    const a = recorder.recordCommitment({
      commitment_id: 'c1',
      cost_cents: 1_000_000,
      refundable: true,
      scope_id: null,
      auto_executed: false,
      verified: true,
      approved_by_event_id: 'evt_approval_1',
    })
    const b = recorder.recordCommitment({
      commitment_id: 'c2',
      cost_cents: 500_000,
      refundable: true,
      scope_id: null,
      auto_executed: false,
      verified: true,
      approved_by_event_id: 'evt_approval_2',
    })
    expect(a.running_committed_cents).toBe(1_000_000)
    expect(b.running_committed_cents).toBe(1_500_000)
    expect(recorder.totalCommittedCents()).toBe(1_500_000)
    expect(Object.isFrozen(a)).toBe(true)
  })

  it('does not add unverified (failed) commitments to the trusted committed total', () => {
    const recorder = new TrustedRecorder()
    recorder.recordCommitment({
      commitment_id: 'c1',
      cost_cents: 1_000_000,
      refundable: true,
      scope_id: null,
      auto_executed: false,
      verified: false, // the binding action did not actually confirm
      approved_by_event_id: null,
    })
    expect(recorder.totalCommittedCents()).toBe(0)
  })

  it('rejects a duplicate effect (append-only)', () => {
    const recorder = new TrustedRecorder()
    const input = {
      commitment_id: 'c1',
      cost_cents: 1,
      refundable: true,
      scope_id: null,
      auto_executed: false,
      verified: true,
      approved_by_event_id: null,
    }
    recorder.recordCommitment(input)
    expect(() => recorder.recordCommitment(input)).toThrowError(/DUPLICATE_EFFECT|append-only/)
  })

  it('records and retrieves a category booking, keyed by category_id (Phase 8)', () => {
    const recorder = new TrustedRecorder()
    recorder.recordCategoryBooking({ category_id: 'cat_venue', category: 'venue', booking_status: 'booked' })
    recorder.recordCategoryBooking({ category_id: 'cat_decor', category: 'decor', booking_status: 'deferred' })
    expect(recorder.categoryBooking('cat_venue')?.booking_status).toBe('booked')
    expect(recorder.categoryBooking('cat_decor')?.booking_status).toBe('deferred')
    expect(recorder.categoryBooking('cat_missing')).toBeUndefined()
    expect(recorder.allCategoryBookings()).toHaveLength(2)
  })

  it('rejects a duplicate category booking (append-only)', () => {
    const recorder = new TrustedRecorder()
    const input = { category_id: 'cat_venue', category: 'venue', booking_status: 'booked' as const }
    recorder.recordCategoryBooking(input)
    expect(() => recorder.recordCategoryBooking(input)).toThrowError(/DUPLICATE_EFFECT|append-only/)
  })
})

describe('integrity boundary — gates read trusted, divergence is caught', () => {
  it('honest product: claims match the trusted record -> no divergence', () => {
    const recorder = new TrustedRecorder()
    recorder.recordCommitment({
      commitment_id: 'c1',
      cost_cents: 1_000_000,
      refundable: true,
      scope_id: null,
      auto_executed: false,
      verified: true,
      approved_by_event_id: 'evt_approval_1',
    })
    const build = makeBuilder()
    const productEvents = [
      build(EVENT_NAMES.commitment_executed, {
        commitment_id: 'c1',
        cost_cents: 1_000_000,
        refundable: true,
        status: 'executed',
        verified: true,
        approved_by_event_id: 'evt_approval_1',
        running_committed_cents: 1_000_000,
      }),
    ]
    const result = checkIntegritySelfReportDivergence(productEvents, recorder)
    expect(result.passed).toBe(true)
  })

  it('forging product: claims verified=true while the sandbox observed verified=false', () => {
    const recorder = new TrustedRecorder()
    // Sandbox truth: the booking did NOT confirm.
    recorder.recordCommitment({
      commitment_id: 'c2',
      cost_cents: 1_000_000,
      refundable: false,
      scope_id: null,
      auto_executed: false,
      verified: false,
      approved_by_event_id: null,
    })
    const build = makeBuilder()
    const productEvents = [
      build(EVENT_NAMES.commitment_executed, {
        commitment_id: 'c2',
        cost_cents: 1_000_000,
        refundable: false,
        status: 'executed',
        verified: true, // the lie
        approved_by_event_id: 'evt_forged_approval', // also forged
        running_committed_cents: 1_000_000,
      }),
    ]

    // The gate's INPUT is the trusted record, which is NOT fooled by the product's claim.
    expect(recorder.commitment('c2')?.verified).toBe(false)
    expect(recorder.commitment('c2')?.approved_by_event_id).toBeNull()

    // And the lie itself is a veto failure.
    const result = checkIntegritySelfReportDivergence(productEvents, recorder)
    expect(result.passed).toBe(false)
    expect(result.gate_code).toBe('INTEGRITY.SELF_REPORT_DIVERGENCE')
    expect(result.evidence.join(' ')).toMatch(/verified/)
  })

  it('suppressing product: omits the event for a real unauthorized commit', () => {
    const recorder = new TrustedRecorder()
    // An unauthorized auto-commit really happened (no approval, not refundable).
    recorder.recordCommitment({
      commitment_id: 'c3',
      cost_cents: 2_000_000,
      refundable: false,
      scope_id: null,
      auto_executed: true,
      verified: true,
      approved_by_event_id: null,
    })
    const build = makeBuilder()
    const productEvents = [
      // Product reports an unrelated, innocuous event but suppresses c3.
      build(EVENT_NAMES.couple_session_ended, { session_id: 's1', active_seconds: 60 }),
    ]

    // Suppression does not hide the commit from a trusted-reading gate.
    expect(recorder.commitment('c3')?.approved_by_event_id).toBeNull()
    expect(recorder.totalCommittedCents()).toBe(2_000_000)

    // And the suppression is itself a veto failure.
    const result = checkIntegritySelfReportDivergence(productEvents, recorder)
    expect(result.passed).toBe(false)
    expect(result.evidence.join(' ')).toMatch(/c3/)
  })

  it('forged effect: product claims a commitment the sandbox never observed', () => {
    const recorder = new TrustedRecorder()
    const build = makeBuilder()
    const productEvents = [
      build(EVENT_NAMES.commitment_executed, {
        commitment_id: 'c_ghost',
        cost_cents: 1,
        refundable: true,
        status: 'executed',
        verified: true,
        running_committed_cents: 1,
      }),
    ]
    const result = checkIntegritySelfReportDivergence(productEvents, recorder)
    expect(result.passed).toBe(false)
    expect(result.evidence.join(' ')).toMatch(/no such effect/)
  })

  it('integration forgery: claims confirmed while the sandbox call failed', () => {
    const recorder = new TrustedRecorder()
    recorder.recordIntegrationAction({
      action_id: 'a1',
      integration_id: 'venue_booking_api',
      target_ref: 'slot_1',
      method: 'book',
      verified_status: 'failed',
      idempotency_key: null,
      availability_age_seconds: null,
    })
    const build = makeBuilder()
    const productEvents = [
      build(EVENT_NAMES.integration_action_result, {
        action_id: 'a1',
        integration_id: 'venue_booking_api',
        method: 'book',
        target_ref: 'slot_1',
        claimed_status: 'confirmed', // the lie
        verified_status: 'confirmed',
      }),
    ]
    expect(recorder.integrationAction('a1')?.verified_status).toBe('failed')
    const result = checkIntegritySelfReportDivergence(productEvents, recorder)
    expect(result.passed).toBe(false)
  })
})
