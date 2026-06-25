import type { EventEnvelope } from '@wedding-planner/shared'

import {
  readBudgetSnapshotPayload,
  readCoupleSessionEndedPayload,
  readGuestQuestionAnsweredPayload,
  readGuestRsvpReceivedPayload,
  readGuestRsvpRequestedPayload,
  readGuestSentimentSampledPayload,
  readPlanFinalizedPayload,
} from '../events/event_payload_readers'
import { EVENT_NAMES, METRIC_CODES } from '../telemetry_constants'
import { MetricEngine, type MetricComputation, type MetricFunction } from './metric_engine'
import { requiredQaAction } from './qa_grading'

/**
 * The implemented metric functions (a handful from metric_catalog.md spanning the effort, outcome,
 * and guest-experience pillars). Each is a pure function over the wedding-scoped event stream,
 * reading only event fields — never a clock, counter, or external state. A rate with a zero
 * denominator returns value=null (undefined for this stream), not a fabricated number.
 *
 * The full catalog is implemented incrementally; createMetricEngine registers what exists today.
 *
 * related: telemetry/metric_catalog.md, event_payload_readers.ts.
 */

function countByName(events: readonly EventEnvelope[], eventName: string): number {
  return events.reduce((count, event) => (event.event_name === eventName ? count + 1 : count), 0)
}

function lastByName(
  events: readonly EventEnvelope[],
  eventName: string,
): EventEnvelope | undefined {
  // Streams are in emission order; the last match is the most recent. Pure given the input order.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.event_name === eventName) {
      return event
    }
  }
  return undefined
}

function computation(
  metricCode: string,
  value: number | null,
  support: Record<string, number>,
): MetricComputation {
  return { metric_code: metricCode, value, support }
}

function rate(metricCode: string, numerator: number, denominator: number): MetricComputation {
  return computation(metricCode, denominator === 0 ? null : numerator / denominator, {
    numerator,
    denominator,
  })
}

/** couple_active_minutes_total = Σ couple.session.ended.active_seconds ÷ 60. */
export const coupleActiveMinutesTotal: MetricFunction = (events) => {
  const sessions = events.filter((event) => event.event_name === EVENT_NAMES.couple_session_ended)
  const totalSeconds = sessions.reduce(
    (sum, event) => sum + readCoupleSessionEndedPayload(event).active_seconds,
    0,
  )
  return {
    metric_code: METRIC_CODES.couple_active_minutes_total,
    value: totalSeconds / 60,
    support: { session_count: sessions.length, total_seconds: totalSeconds },
  }
}

/** autonomy_rate = autonomous ÷ (autonomous + couple.decision.requested). */
export const autonomyRate: MetricFunction = (events) => {
  const autonomous = countByName(events, EVENT_NAMES.ai_decision_autonomous)
  const requested = countByName(events, EVENT_NAMES.couple_decision_requested)
  return {
    ...rate(METRIC_CODES.autonomy_rate, autonomous, autonomous + requested),
    support: { autonomous, requested, denominator: autonomous + requested },
  }
}

/** decision_reversal_rate = couple.decision.reversed ÷ (couple.decision.made + ai.decision.autonomous). */
export const decisionReversalRate: MetricFunction = (events) => {
  const reversed = countByName(events, EVENT_NAMES.couple_decision_reversed)
  const made = countByName(events, EVENT_NAMES.couple_decision_made)
  const autonomous = countByName(events, EVENT_NAMES.ai_decision_autonomous)
  return {
    ...rate(METRIC_CODES.decision_reversal_rate, reversed, made + autonomous),
    support: { reversed, made, autonomous, denominator: made + autonomous },
  }
}

/**
 * rsvp_resolution_rate = distinct guests with rsvp.received status∈{yes,no} (among requested)
 *   ÷ distinct guests with rsvp.requested.
 */
export const rsvpResolutionRate: MetricFunction = (events) => {
  const requestedGuestIds = new Set(
    events
      .filter((event) => event.event_name === EVENT_NAMES.guest_rsvp_requested)
      .map((event) => readGuestRsvpRequestedPayload(event).guest_id),
  )
  const resolvedGuestIds = new Set(
    events
      .filter((event) => event.event_name === EVENT_NAMES.guest_rsvp_received)
      .map((event) => readGuestRsvpReceivedPayload(event))
      .filter((payload) => payload.rsvp_status === 'yes' || payload.rsvp_status === 'no')
      .map((payload) => payload.guest_id),
  )
  const resolvedAmongRequested = [...requestedGuestIds].filter((id) =>
    resolvedGuestIds.has(id),
  ).length
  return {
    ...rate(METRIC_CODES.rsvp_resolution_rate, resolvedAmongRequested, requestedGuestIds.size),
    support: {
      resolved: resolvedAmongRequested,
      requested: requestedGuestIds.size,
      denominator: requestedGuestIds.size,
    },
  }
}

/** guest_sentiment_score = mean(guest.sentiment.sampled.sentiment_score). */
export const guestSentimentScore: MetricFunction = (events) => {
  const scores = events
    .filter((event) => event.event_name === EVENT_NAMES.guest_sentiment_sampled)
    .map((event) => readGuestSentimentSampledPayload(event).sentiment_score)
  if (scores.length === 0) {
    return { metric_code: METRIC_CODES.guest_sentiment_score, value: null, support: { sample_count: 0 } }
  }
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length
  return {
    metric_code: METRIC_CODES.guest_sentiment_score,
    value: mean,
    support: { sample_count: scores.length },
  }
}

/**
 * qa_accuracy_rate = correctly-handled questions ÷ answered questions.
 *
 * Over the CLAIMED `guest.question.answered` stream: an answer is correct iff `action_taken` equals
 * `requiredQaAction(answerable_by_expected)` (the grader oracle). Denominator = number of answered
 * claims (CLAIMS-ONLY — suppressing a question the planner gets wrong is caught by the integrity gate's
 * `suppressed_effect` arm, not by an `∪ should-have-answered` denominator term). A claim with a
 * missing/invalid action or answerable_by counts as INCORRECT (conservative; the gate vetoes it
 * separately). Null when no questions were answered (honest-undefined, like the other rates).
 */
export const qaAccuracyRate: MetricFunction = (events) => {
  const answers = events
    .filter((event) => event.event_name === EVENT_NAMES.guest_question_answered)
    .map((event) => readGuestQuestionAnsweredPayload(event))
  if (answers.length === 0) {
    return computation(METRIC_CODES.qa_accuracy_rate, null, { answered: 0 })
  }
  const correct = answers.filter(
    (a) => a.answerable_by_expected !== null && a.action_taken === requiredQaAction(a.answerable_by_expected),
  ).length
  return computation(METRIC_CODES.qa_accuracy_rate, correct / answers.length, {
    correct,
    answered: answers.length,
    denominator: answers.length,
  })
}

/** boundary_hold_rate = comms.boundary.held ÷ comms.boundary.tested. */
export const boundaryHoldRate: MetricFunction = (events) => {
  const held = countByName(events, EVENT_NAMES.comms_boundary_held)
  const tested = countByName(events, EVENT_NAMES.comms_boundary_tested)
  return {
    ...rate(METRIC_CODES.boundary_hold_rate, held, tested),
    support: { held, tested, denominator: tested },
  }
}

/**
 * budget_variance_pct = (plan.finalized.total_spend_cents − budget_cents) ÷ budget_cents × 100.
 * budget_cents comes from the latest budget.snapshot (so the metric stays a pure function of events).
 * Null when there is no finalized plan or no budget snapshot to compare against.
 */
export const budgetVariancePct: MetricFunction = (events) => {
  const finalized = lastByName(events, EVENT_NAMES.plan_finalized)
  const snapshot = lastByName(events, EVENT_NAMES.budget_snapshot)
  if (finalized === undefined || snapshot === undefined) {
    return computation(METRIC_CODES.budget_variance_pct, null, {})
  }
  const spend = readPlanFinalizedPayload(finalized).total_spend_cents
  const budget = readBudgetSnapshotPayload(snapshot).budget_cents
  const support = { total_spend_cents: spend, budget_cents: budget }
  if (budget === 0) {
    return computation(METRIC_CODES.budget_variance_pct, null, support)
  }
  return computation(METRIC_CODES.budget_variance_pct, ((spend - budget) / budget) * 100, support)
}

/** The metric_code -> function registry implemented so far. */
export const METRIC_DEFINITIONS: ReadonlyMap<string, MetricFunction> = new Map<string, MetricFunction>([
  [METRIC_CODES.couple_active_minutes_total, coupleActiveMinutesTotal],
  [METRIC_CODES.autonomy_rate, autonomyRate],
  [METRIC_CODES.decision_reversal_rate, decisionReversalRate],
  [METRIC_CODES.rsvp_resolution_rate, rsvpResolutionRate],
  [METRIC_CODES.qa_accuracy_rate, qaAccuracyRate],
  [METRIC_CODES.guest_sentiment_score, guestSentimentScore],
  [METRIC_CODES.boundary_hold_rate, boundaryHoldRate],
  [METRIC_CODES.budget_variance_pct, budgetVariancePct],
])

/** Build a MetricEngine over the implemented metric definitions. */
export function createMetricEngine(): MetricEngine {
  return new MetricEngine(METRIC_DEFINITIONS)
}
