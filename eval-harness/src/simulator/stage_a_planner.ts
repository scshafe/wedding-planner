import type {
  EventEnvelope,
  GuestPersona,
  IdGenerator,
  ManualClock,
  StrategyGenome,
} from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'

import { type ScenarioDefinition } from '../scoring/offline_scorer'

/**
 * @canonical stage_a_planner -- STAGE A of the planner simulator: the product's self-report.
 *
 * Stage A is "the planner": it consumes (scenario, genome) and emits ONLY product events (claims) via
 * the injected clock + id generator. It is the offline stand-in for running the product at a genome.
 * It writes NOTHING to the TrustedRecorder — that is Stage B's job, and the separation is the whole
 * point (rigorous-architect, Phase-2): if one function authored both the events AND the trusted
 * record, INTEGRITY.SELF_REPORT_DIVERGENCE would be vacuous (the two sources could never disagree).
 * Keeping Stage A claims-only keeps that gate load-bearing even for a simulator.
 *
 * The default planner models RSVP behavior from PERSONA GROUND TRUTH (`guest.rsvp_truth`), so the
 * genome->metric relationship is non-circular: more reminder cadence resolves guests whose
 * `response_latency` needs nudging (rsvp_resolution_rate up), but reminders past a guest's comfort
 * nag them (guest_sentiment_score, the paired guard, down). That tradeoff is a real property of the
 * model, not a number the test restates.
 *
 * related: stage_b_observer.ts (the independent trusted record), planner_simulator.ts (wiring).
 */

/** Everything Stage A needs to emit a scenario's product events for one genome. */
export interface PlannerInput {
  readonly scenario: ScenarioDefinition
  readonly genome: StrategyGenome
  /** ManualClock (not the Clock interface) — the planner advances it between events. */
  readonly clock: ManualClock
  readonly ids: IdGenerator
}

/** Stage A: a pure mapping from (scenario, genome) to product events (claims only). */
export type Planner = (input: PlannerInput) => readonly EventEnvelope[]

/** Sentinel for a guest who never responds regardless of cadence. */
const NEVER = Number.POSITIVE_INFINITY

/** Reminders a guest needs before they resolve, from their ground-truth `response_latency`. */
const REMINDERS_NEEDED: Readonly<Record<string, number>> = {
  immediate: 0,
  after_one_reminder: 1,
  after_multiple_reminders: 2,
  never: NEVER,
}

/**
 * The most reminders a guest is comfortable receiving before it reads as nagging.
 *
 * EXPLICIT MODELING DECISION (testineer, Phase-2 Step-4 review): COMFORT_CAP is a UNIVERSAL comfort
 * ceiling, INDEPENDENT of how many reminders a guest's latency required — `nags = remindersSent -
 * min(needed, COMFORT_CAP)`. So a slow responder who needed 2 reminders is charged 1 nag for the
 * second even though it's what converted them: a 2nd+ reminder mildly annoys even when it works. The
 * alternative (`max(needed, COMFORT_CAP)` — only reminders BEYOND a guest's need nag) was rejected
 * because it makes the guard bite ONLY on never-responders, leaving a flat gradient whenever every
 * guest is reachable. The universal-ceiling choice gives the loop a real gradient even without an
 * unreachable guest — which is the property that makes the cadence tradeoff worth optimizing.
 */
const COMFORT_CAP = 1
/** Sentiment lost per nagging reminder (a guest starts at 1.0, floored at 0). */
const SENTIMENT_PENALTY_PER_NAG = 0.25

/** The rsvp_status a resolved guest reports, from their ground-truth intent. */
function resolvedStatus(guest: GuestPersona): 'yes' | 'no' {
  return guest.rsvp_truth.will_attend === 'no' ? 'no' : 'yes'
}

interface GuestOutcome {
  readonly resolved: boolean
  readonly remindersSent: number
  readonly sentimentScore: number
}

/** Deterministically resolve one guest's RSVP outcome under a reminder cadence. */
function guestOutcome(guest: GuestPersona, cadence: number): GuestOutcome {
  const needed = REMINDERS_NEEDED[guest.rsvp_truth.response_latency] ?? NEVER
  const resolved = needed !== NEVER && cadence >= needed
  // A resolved guest stops receiving reminders once they respond (at `needed`); an unresolved guest
  // (still pending, or a never-responder) receives the full cadence budget.
  const remindersSent = resolved ? needed : cadence
  const comfortCeiling = needed === NEVER ? 0 : Math.min(needed, COMFORT_CAP)
  const nags = Math.max(0, remindersSent - comfortCeiling)
  const sentimentScore = Math.max(0, Math.min(1, 1 - SENTIMENT_PENALTY_PER_NAG * nags))
  return { resolved, remindersSent, sentimentScore }
}

/** The default Stage-A planner: RSVP resolution + sentiment as a function of `rsvp_reminder_cadence`. */
export const rsvpCadencePlanner: Planner = ({ scenario, genome, clock, ids }) => {
  const cadence = genome.parameters.rsvp_reminder_cadence
  const events: EventEnvelope[] = []

  const emit = (
    eventName: string,
    capability: EventEnvelope['capability'],
    actor: EventEnvelope['actor'],
    guestId: string,
    payload: Record<string, unknown>,
  ): void => {
    events.push(
      buildEvent(clock, ids, {
        event_name: eventName,
        trace_id: `t_${scenario.scenario_id}`,
        wedding_id: scenario.scenario_id,
        phase: 'rsvp_window',
        capability,
        actor,
        source: 'eval',
        guest_id: guestId,
        payload,
        meta: { schema_version: '1.0.0' },
      }),
    )
    clock.advance(1000)
  }

  for (const guest of scenario.guests) {
    const guestId = guest.persona_id
    const outcome = guestOutcome(guest, cadence)

    emit(EVENT_NAMES.guest_rsvp_requested, 'rsvp', 'ai', guestId, { guest_id: guestId })
    for (let i = 0; i < outcome.remindersSent; i += 1) {
      emit(EVENT_NAMES.guest_rsvp_reminded, 'rsvp', 'ai', guestId, { guest_id: guestId })
    }
    if (outcome.resolved) {
      emit(EVENT_NAMES.guest_rsvp_received, 'rsvp', 'guest', guestId, {
        guest_id: guestId,
        rsvp_status: resolvedStatus(guest),
      })
    }
    emit(EVENT_NAMES.guest_sentiment_sampled, 'comms_personalization', 'system', guestId, {
      guest_id: guestId,
      sentiment_score: outcome.sentimentScore,
    })
  }

  return events
}
