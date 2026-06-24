import {
  loadCouplePersona,
  type ProductRunner,
  type ScenarioDefinition,
  TrustedRecorder,
} from '@wedding-planner/eval-harness'
import { type EventEnvelope, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'

/**
 * A trivial two-scenario corpus and a sandbox-stub runner for loop/pipeline integration tests. The
 * candidate variant resolves one more RSVP than the baseline (so rsvp_resolution_rate and the North
 * Star rise) when `improve` is true; otherwise it behaves identically (no improvement -> rejected).
 * Both variants satisfy the couple's hard constraints and make no commitments/sends, so the veto
 * gates hold.
 */
const couple = loadCouplePersona('couple_standard_baseline')

export const RSVP_CORPUS: ScenarioDefinition[] = [
  { scenario_id: 'golden_g1', scenario_type: 'golden', couple, guests: [], bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.9 }] },
  { scenario_id: 'adversarial_a1', scenario_type: 'adversarial', couple, guests: [], bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.9 }] },
]

export function makeRsvpRunner(improve: boolean): ProductRunner {
  return (scenario, variant) => {
    const recorder = new TrustedRecorder()
    for (const hardConstraint of scenario.couple.hard_constraints) {
      recorder.recordConstraintDetermination({
        constraint_id: hardConstraint.constraint_id,
        constraint_type: hardConstraint.type,
        satisfied: true,
        severity: (hardConstraint.severity as 'fatal' | 'serious' | 'moderate' | undefined) ?? 'serious',
        plan_element_ref: null,
      })
    }
    const clock = new ManualClock('2027-01-02T15:00:00.000Z')
    const ids = new SequentialIdGenerator(`${scenario.scenario_id}_${variant}`)
    const events: EventEnvelope[] = []
    const emit = (eventName: string, payload: Record<string, unknown>, guestId: string): void => {
      events.push(
        buildEvent(clock, ids, {
          event_name: eventName,
          trace_id: `t_${scenario.scenario_id}`,
          wedding_id: scenario.scenario_id,
          phase: 'rsvp_window',
          capability: 'rsvp',
          actor: eventName === EVENT_NAMES.guest_rsvp_received ? 'guest' : 'ai',
          source: 'eval',
          guest_id: guestId,
          payload,
          meta: { schema_version: '1.0.0' },
        }),
      )
      clock.advance(1000)
    }
    for (const guest of ['g1', 'g2', 'g3']) {
      emit(EVENT_NAMES.guest_rsvp_requested, { guest_id: guest }, guest)
    }
    // Phase 4b: an HONEST product authors a trusted RSVP outcome for every resolution it claims (the
    // integrity gate now reconciles guest.rsvp.received against the trusted record). A claim with no
    // matching outcome here would be a forged_effect veto — which is exactly the firewall working.
    const resolve = (guestId: string, status: 'yes' | 'no'): void => {
      recorder.recordRsvpOutcome({ guest_id: guestId, rsvp_status: status, resolved_via: 'reminder' })
      emit(EVENT_NAMES.guest_rsvp_received, { guest_id: guestId, rsvp_status: status }, guestId)
    }
    resolve('g1', 'yes')
    resolve('g2', 'no')
    if (improve && variant === 'candidate') {
      resolve('g3', 'yes')
    }
    return { recorder, productEvents: events }
  }
}
