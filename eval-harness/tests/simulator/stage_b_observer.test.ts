import { EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import {
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { observeTrustedRecord, rsvpCadencePlanner } from '@wedding-planner/eval-harness'

import { makeGenome, makeGuest, makeScenario, makeTier2Genome } from './simulator_fixtures'

/**
 * Phase-4b Step 2: Stage B independently authors the trusted RSVP-outcome + couple-session record from
 * (scenario, genome) ground truth ALONE. These tests pin WHAT it authors and — critically — that the
 * HONEST Stage A reproduces exactly Stage B's reminder-resolved set (the agreement the Step-3 integrity
 * gate relies on so honest runs stay green).
 */

const BASE_TS = '2026-02-01T00:00:00.000Z'

/** The set of guest_ids the HONEST Stage A claims it resolved, for a genome over a scenario. */
function honestResolvedGuestIds(genome: StrategyGenome, scenarioGuests: ReturnType<typeof makeGuest>[]): Set<string> {
  const scenario = makeScenario('s_honest', scenarioGuests)
  const events = rsvpCadencePlanner({
    scenario,
    genome,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('sb_test'),
  })
  return new Set(
    events
      .filter((e) => e.event_name === EVENT_NAMES.guest_rsvp_received)
      .map((e) => (e.payload as { guest_id: string }).guest_id),
  )
}

describe('Stage B — trusted RSVP-outcome authoring (reminder path, tier-1 genome)', () => {
  const guests = [
    makeGuest('g_immediate', 'immediate', 'yes'),
    makeGuest('g_one', 'after_one_reminder', 'yes'),
    makeGuest('g_many', 'after_multiple_reminders', 'no'),
    makeGuest('g_never', 'never', 'maybe_needs_nudge'),
  ]

  it('records a reminder-resolved outcome for exactly the guests cadence/spacing reach, and no couple sessions', () => {
    const genome = makeGenome(1, 0) // cadence 1: reaches immediate (0) + one_reminder (1); not many (2)/never
    const recorder = observeTrustedRecord(makeScenario('s', guests), genome)

    const resolved = recorder.allRsvpOutcomes()
    expect(resolved.map((r) => r.guest_id).sort()).toEqual(['g_immediate', 'g_one'])
    expect(resolved.every((r) => r.resolved_via === 'reminder')).toBe(true)
    expect(recorder.rsvpOutcome('g_immediate')?.rsvp_status).toBe('yes')
    // No tier-2 knob ⇒ no escalation, no couple cost.
    expect(recorder.allCoupleSessions()).toHaveLength(0)
  })

  it('agrees with the HONEST Stage A claimed resolution set (the gate-green prerequisite)', () => {
    for (const cadence of [0, 1, 2, 3]) {
      for (const spacing of [0, 1, 2, 3]) {
        const genome = makeGenome(cadence, spacing)
        const trusted = new Set(
          observeTrustedRecord(makeScenario('s', guests), genome)
            .allRsvpOutcomes()
            .map((r) => r.guest_id),
        )
        expect(honestResolvedGuestIds(genome, guests), `c${cadence} s${spacing}`).toEqual(trusted)
      }
    }
  })
})

describe('Stage B — couple escalation authoring (tier-2 genome)', () => {
  // Two never-responders to reminders; one is couple-resolvable, one is not.
  const guests = [
    makeGuest('g_immediate', 'immediate', 'yes'),
    makeGuest('g_relative', 'never', 'yes', true), // couple can call them
    makeGuest('g_stranger', 'never', 'no', false), // couple cannot resolve
  ]

  it('escalates pending couple-resolvable guests (resolution + couple cost); skips non-resolvable', () => {
    const recorder = observeTrustedRecord(makeScenario('s', guests), makeTier2Genome(1, 0, 1))

    // g_immediate via reminder; g_relative via couple; g_stranger never resolved.
    expect(recorder.rsvpOutcome('g_immediate')?.resolved_via).toBe('reminder')
    expect(recorder.rsvpOutcome('g_relative')?.resolved_via).toBe('couple')
    expect(recorder.rsvpOutcome('g_relative')?.rsvp_status).toBe('yes')
    expect(recorder.rsvpOutcome('g_stranger')).toBeUndefined()

    // The escalation consumed exactly one couple session (the cost), keyed by the escalated guest.
    const sessions = recorder.allCoupleSessions()
    expect(sessions.map((s) => s.guest_id)).toEqual(['g_relative'])
    expect(sessions[0]?.active_seconds).toBeGreaterThan(0)
  })

  it('is monotone in autonomy_threshold: a higher threshold escalates at least as many guests', () => {
    const many = [
      makeGuest('g_a', 'never', 'yes', true),
      makeGuest('g_b', 'never', 'yes', true),
      makeGuest('g_c', 'never', 'yes', true),
    ]
    const count = (t: number): number =>
      observeTrustedRecord(makeScenario('s', many), makeTier2Genome(0, 0, t)).allCoupleSessions().length
    expect(count(1)).toBe(1)
    expect(count(2)).toBe(2)
    expect(count(3)).toBe(3) // threshold 3 = escalate all pending couple-resolvable
    expect(count(1)).toBeLessThanOrEqual(count(2))
    expect(count(2)).toBeLessThanOrEqual(count(3))
  })
})
