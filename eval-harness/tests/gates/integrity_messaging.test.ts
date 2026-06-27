import {
  checkIntegritySelfReportDivergence,
  detectSelfReportDivergence,
  makePlannerSimulator,
  observeTrustedRecord,
  type SelfReportDivergence,
  TrustedRecorder,
} from '@wedding-planner/eval-harness'
import { type EventEnvelope, genomeArtifactRef, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import { makeGenome, makeGuest, makeScenario, refFor } from '../simulator/simulator_fixtures'

/**
 * Phase-20 Step 2: the integrity gate's 9th reconciled effect kind `messaging_spend`. It backs the claimed
 * `messaging_money_total_cents` (the North-Star money_cost DENOMINATOR), keyed on `guest_id`, and — because
 * money_cost is LOWER-better, so the incentive is to UNDER-report — it defends BOTH the priced quantity
 * (`message_count`) and the price basis (`channel`), plus the SUPPRESSION attack (drop a guest's send, the
 * highest-yield move for a summed cost). It mirrors `couple_session` (a summed cost ⇒ no duplicate-as-forge
 * arm). These tests pin every arm, that an honest run reconciles clean, the zero-send byte-identity guard, and
 * the joint resolution+count forge (the trusted count is pinned to the trusted resolution, not the claim).
 */

function makeBuilder(): (payload: Record<string, unknown>) => EventEnvelope {
  const clock = new ManualClock('2027-02-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('seedMsgIntegrity')
  return (payload) =>
    buildEvent(clock, ids, {
      event_name: EVENT_NAMES.guest_messaging_metered,
      trace_id: 'trace_1',
      wedding_id: 'wed_1',
      phase: 'rsvp_window',
      capability: 'comms_personalization',
      actor: 'system',
      source: 'eval',
      payload,
      meta: { schema_version: '1.0.0' },
    })
}

function msgDivs(events: readonly EventEnvelope[], recorder: TrustedRecorder): SelfReportDivergence[] {
  return detectSelfReportDivergence(events, recorder).filter((d) => d.effect_kind === 'messaging_spend')
}

/** A recorder for two guests with honest sends: 2 emails and 1 sms. */
function honestRecorder(): TrustedRecorder {
  const recorder = new TrustedRecorder()
  recorder.recordMessagingSpend({ guest_id: 'g_email', channel: 'email', message_count: 2 })
  recorder.recordMessagingSpend({ guest_id: 'g_sms', channel: 'sms', message_count: 1 })
  return recorder
}

describe('integrity — messaging reconciliation (the claimed messaging_money_total_cents)', () => {
  it('passes when the claimed sends match the trusted record (channel AND count)', () => {
    const emit = makeBuilder()
    const events = [
      emit({ guest_id: 'g_email', channel: 'email', message_count: 2 }),
      emit({ guest_id: 'g_sms', channel: 'sms', message_count: 1 }),
    ]
    expect(checkIntegritySelfReportDivergence(events, honestRecorder()).passed).toBe(true)
    expect(msgDivs(events, honestRecorder())).toHaveLength(0)
  })

  it('field_mismatch — a SHAVED message_count (the quantity forge) is vetoed', () => {
    const emit = makeBuilder()
    const events = [
      emit({ guest_id: 'g_email', channel: 'email', message_count: 1 }), // honest is 2
      emit({ guest_id: 'g_sms', channel: 'sms', message_count: 1 }),
    ]
    const divs = msgDivs(events, honestRecorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('message_count')
  })

  it('field_mismatch — a DOWNGRADED channel (the price-basis forge) is vetoed', () => {
    const emit = makeBuilder()
    // Claim the cheaper email channel for the guest the trusted record observed on sms.
    const events = [
      emit({ guest_id: 'g_email', channel: 'email', message_count: 2 }),
      emit({ guest_id: 'g_sms', channel: 'email', message_count: 1 }),
    ]
    const divs = msgDivs(events, honestRecorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('channel')
  })

  it('field_mismatch — an ABSENT message_count against a positive trusted count is a veto (skipWhenClaimAbsent:false)', () => {
    const emit = makeBuilder()
    const events = [
      emit({ guest_id: 'g_email', channel: 'email' }), // no message_count field
      emit({ guest_id: 'g_sms', channel: 'sms', message_count: 1 }),
    ]
    const divs = msgDivs(events, honestRecorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('message_count')
  })

  it('forged_effect — an ABSENT/UNKNOWN channel is caught BEFORE the cost table is indexed', () => {
    const emit = makeBuilder()
    const absent = [emit({ guest_id: 'g_x', message_count: 2 })] // no channel
    const unknown = [emit({ guest_id: 'g_x', channel: 'carrier_pigeon', message_count: 2 })]
    for (const events of [absent, unknown]) {
      // Empty recorder so the channel forge is isolated (the bad claim never reaches a trusted lookup).
      const divs = msgDivs(events, new TrustedRecorder())
      expect(divs).toHaveLength(1)
      expect(divs[0]?.kind).toBe('forged_effect')
      expect(divs[0]?.field).toBe('channel')
    }
  })

  it('forged_effect — a claim for a guest the trusted record never observed (incl. a 0-send guest)', () => {
    const emit = makeBuilder()
    const events = [
      emit({ guest_id: 'g_email', channel: 'email', message_count: 2 }),
      emit({ guest_id: 'g_immediate', channel: 'email', message_count: 1 }), // 0-send guest: no trusted record
      emit({ guest_id: 'g_sms', channel: 'sms', message_count: 1 }),
    ]
    const divs = msgDivs(events, honestRecorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(divs[0]?.effect_id).toBe('g_immediate')
  })

  it('forged_effect — a claim with no guest_id (no trusted join key)', () => {
    const emit = makeBuilder()
    const events = [emit({ channel: 'email', message_count: 2 })]
    // Empty recorder so the missing-key forge is isolated from suppression of unrelated trusted records.
    const divs = msgDivs(events, new TrustedRecorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(divs[0]?.field).toBe('guest_id')
  })

  it('suppressed_effect — dropping a guest`s send (the summed-cost attack) is vetoed', () => {
    const emit = makeBuilder()
    const events = [emit({ guest_id: 'g_email', channel: 'email', message_count: 2 })] // g_sms dropped
    const divs = msgDivs(events, honestRecorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('suppressed_effect')
    expect(divs[0]?.effect_id).toBe('g_sms')
  })

  it('NO duplicate-as-forge arm — a duplicate claim ADDS cost (self-harm), reconciles again harmlessly', () => {
    // A summed cost makes a duplicate self-harming, so (unlike sentiment/qa/category) a 2nd claim for the
    // same guest is NOT a forge — it just reconciles against the same trusted record again (both pass the
    // field diff). The recorder is append-only-per-guest, so the trusted side can never duplicate.
    const emit = makeBuilder()
    const events = [
      emit({ guest_id: 'g_email', channel: 'email', message_count: 2 }),
      emit({ guest_id: 'g_email', channel: 'email', message_count: 2 }), // duplicate — not a forge
      emit({ guest_id: 'g_sms', channel: 'sms', message_count: 1 }),
    ]
    expect(msgDivs(events, honestRecorder())).toHaveLength(0)
  })

  it('JOINT FORGE — claiming a guest resolved AND shaving its count to match is still vetoed (count pinned to trusted resolution)', () => {
    // doddy P0-2: an unresolved multi-reminder guest honestly SENDS `delivered` (e.g. 3) messages; a candidate
    // that claims it RESOLVED would (consistently) report the lower resolved count. But the trusted count is
    // derived from Stage B`s OWN resolution (unresolved → 3), so the shaved claim (1) field-mismatches here —
    // independent of whatever the rsvp gate does with the forged resolution.
    const recorder = new TrustedRecorder()
    recorder.recordMessagingSpend({ guest_id: 'g_many', channel: 'email', message_count: 3 })
    const emit = makeBuilder()
    const events = [emit({ guest_id: 'g_many', channel: 'email', message_count: 1 })]
    const divs = msgDivs(events, recorder)
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('message_count')
  })
})

describe('integrity — messaging reconciliation is clean on an HONEST simulator run', () => {
  // End-to-end: Stage A`s claims and Stage B`s trusted record, both from the same (scenario, genome), must
  // reconcile with zero messaging divergence — the load-bearing honest-run guarantee (bit-identical by the
  // shared `honestMessagesSent` fact). Includes a zero-send immediate responder (emits/records nothing) and a
  // spacing-3 guest (delivered === 0 → zero sends), so the byte-identity guard is exercised both ways.
  function honestRunDivergences(cadence: number, spacing: number, batching: number): SelfReportDivergence[] {
    const guests = [
      makeGuest('g_immediate', 'immediate', 'yes'), // 0 reminders → no messaging claim/record
      makeGuest('g_one', 'after_one_reminder', 'yes'),
      makeGuest('g_many', 'after_multiple_reminders', 'no'),
      makeGuest('g_never', 'never', 'maybe_needs_nudge'),
    ]
    const scenario = makeScenario('s_msg_honest', guests)
    const genome = makeGenome(cadence, spacing, batching)
    const events = makePlannerSimulator({
      championGenome: genome,
      candidateGenome: genome,
      candidateArtifactRef: refFor(genome),
      baseTimestamp: '2027-03-01T12:00:00.000Z',
    })(scenario, 'candidate').productEvents
    const recorder = observeTrustedRecord(scenario, genome)
    return detectSelfReportDivergence(events, recorder).filter((d) => d.effect_kind === 'messaging_spend')
  }

  it('reconciles clean across the cube — including zero-send guests and spacing-3 (delivered 0)', () => {
    for (const cadence of [0, 1, 2, 3]) {
      for (const spacing of [0, 1, 2, 3]) {
        for (const batching of [0, 1, 2, 3]) {
          expect(
            honestRunDivergences(cadence, spacing, batching),
            `honest run (${cadence},${spacing},${batching}) must have no messaging divergence`,
          ).toHaveLength(0)
        }
      }
    }
  })

  it('genomeArtifactRef of the honest genome is stable (sanity that the run used the real pipeline)', () => {
    expect(refFor(makeGenome(3, 1, 1))).toBe(genomeArtifactRef(makeGenome(3, 1, 1)))
  })
})
