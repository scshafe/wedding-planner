import type { EventEnvelope, IdGenerator, ManualClock } from '@wedding-planner/shared'

import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'

/**
 * Build a deterministic telemetry event stream for one wedding, covering every implemented metric.
 * The stream is a pure function of the injected (clock, ids) and weddingId — two calls with freshly
 * seeded inputs produce byte-identical events, which is what the replay test asserts. Each event's
 * occurred_at and event_id are injected (clock/ids), never ambient.
 *
 * The metric values this fixture is designed to produce (computed in the test):
 *   couple_active_minutes_total = 50      (1800 + 1200 seconds)
 *   autonomy_rate               = 0.75    (3 autonomous / (3 + 1 requested))
 *   decision_reversal_rate      = 0.2     (1 reversed / (2 made + 3 autonomous))
 *   rsvp_resolution_rate        = 2/3     (g1 yes, g2 no resolved of g1,g2,g3 requested)
 *   guest_sentiment_score       = 0.7     (mean of 0.8, 0.6)
 *   boundary_hold_rate          = 0.5     (1 held / 2 tested)
 *   budget_variance_pct         = 5       ((4_200_000 - 4_000_000) / 4_000_000 * 100)
 */
export function buildSampleEventStream(
  clock: ManualClock,
  ids: IdGenerator,
  weddingId: string,
): EventEnvelope[] {
  const traceId = `trace_${weddingId}`
  const meta = { schema_version: '1.0.0', harness_version: 'h1', product_version: 'p1', seed: 'seedA' }

  const events: EventEnvelope[] = []
  const emit = (
    eventName: string,
    capability: EventEnvelope['capability'],
    actor: EventEnvelope['actor'],
    phase: EventEnvelope['phase'],
    payload: Record<string, unknown>,
    guestId?: string,
  ): void => {
    events.push(
      buildEvent(clock, ids, {
        event_name: eventName,
        trace_id: traceId,
        wedding_id: weddingId,
        phase,
        capability,
        actor,
        source: 'eval',
        ...(guestId === undefined ? {} : { guest_id: guestId }),
        payload,
        meta,
      }),
    )
    clock.advance(60_000) // one minute between events, deterministic
  }

  // Effort: two ended sessions (50 minutes total).
  emit(EVENT_NAMES.couple_session_ended, 'orchestration', 'couple', 'discovery', {
    session_id: 's1',
    active_seconds: 1800,
  })
  emit(EVENT_NAMES.couple_session_ended, 'orchestration', 'couple', 'shortlist', {
    session_id: 's2',
    active_seconds: 1200,
  })

  // Autonomy / reversal: 3 autonomous, 1 requested, 2 made, 1 reversed.
  for (let i = 1; i <= 3; i += 1) {
    emit(EVENT_NAMES.ai_decision_autonomous, 'orchestration', 'ai', 'booking', {
      decision_id: `auto_${i}`,
      outcome: 'auto_decided',
      was_autonomous: true,
    })
  }
  emit(EVENT_NAMES.couple_decision_requested, 'orchestration', 'ai', 'booking', {
    decision_id: 'req_1',
    outcome: 'deferred',
    was_autonomous: false,
  })
  emit(EVENT_NAMES.couple_decision_made, 'orchestration', 'couple', 'booking', {
    decision_id: 'made_1',
    outcome: 'approved',
    was_autonomous: false,
  })
  emit(EVENT_NAMES.couple_decision_made, 'orchestration', 'couple', 'booking', {
    decision_id: 'made_2',
    outcome: 'approved',
    was_autonomous: false,
  })
  emit(EVENT_NAMES.couple_decision_reversed, 'orchestration', 'couple', 'booking', {
    decision_id: 'rev_1',
    outcome: 'reversed',
    was_autonomous: false,
    reverses_decision_id: 'made_1',
  })

  // RSVP: 3 requested (g1,g2,g3), resolved g1=yes, g2=no, g3=maybe (unresolved).
  for (const guestId of ['g1', 'g2', 'g3']) {
    emit(EVENT_NAMES.guest_rsvp_requested, 'rsvp', 'ai', 'rsvp_window', { guest_id: guestId }, guestId)
  }
  emit(EVENT_NAMES.guest_rsvp_received, 'rsvp', 'guest', 'rsvp_window', { guest_id: 'g1', rsvp_status: 'yes', party_size: 2 }, 'g1')
  emit(EVENT_NAMES.guest_rsvp_received, 'rsvp', 'guest', 'rsvp_window', { guest_id: 'g2', rsvp_status: 'no' }, 'g2')
  emit(EVENT_NAMES.guest_rsvp_received, 'rsvp', 'guest', 'rsvp_window', { guest_id: 'g3', rsvp_status: 'maybe' }, 'g3')

  // Sentiment: mean 0.7.
  emit(EVENT_NAMES.guest_sentiment_sampled, 'comms_personalization', 'system', 'rsvp_window', { guest_id: 'g1', sentiment_score: 0.8 }, 'g1')
  emit(EVENT_NAMES.guest_sentiment_sampled, 'comms_personalization', 'system', 'rsvp_window', { guest_id: 'g2', sentiment_score: 0.6 }, 'g2')

  // Boundaries: 2 tested, 1 held.
  emit(EVENT_NAMES.comms_boundary_tested, 'comms_personalization', 'guest', 'rsvp_window', { boundary_type: 'plus_one', guest_id: 'g3' }, 'g3')
  emit(EVENT_NAMES.comms_boundary_tested, 'comms_personalization', 'guest', 'rsvp_window', { boundary_type: 'surprise', guest_id: 'g1' }, 'g1')
  emit(EVENT_NAMES.comms_boundary_held, 'comms_personalization', 'ai', 'rsvp_window', { boundary_type: 'plus_one', guest_id: 'g3' }, 'g3')

  // Budget: snapshot then finalized plan -> +5% variance.
  emit(EVENT_NAMES.budget_snapshot, 'budget_management', 'system', 'booking', {
    committed_cents: 4_200_000,
    forecast_cents: 4_200_000,
    budget_cents: 4_000_000,
  })
  emit(EVENT_NAMES.plan_finalized, 'orchestration', 'system', 'final_week', {
    booked_categories: ['venue', 'catering', 'photography'],
    total_spend_cents: 4_200_000,
    weather_contingency: true,
  })

  return events
}
