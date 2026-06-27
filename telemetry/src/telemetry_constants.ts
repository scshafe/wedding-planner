/**
 * @canonical telemetry_constants -- the controlled string vocabularies for the telemetry domain.
 *
 * The single source of truth for event-name and metric-code strings (telemetry/vocabularies.md,
 * event_catalog.md, metric_catalog.md). Code references these constants, never string literals, so
 * a rename is one edit and a typo is a compile error.
 */

/** Every telemetry event name (event_catalog.md). Dot-delimited, matching the envelope pattern. */
export const EVENT_NAMES = {
  // Couple-interaction family
  couple_session_started: 'couple.session.started',
  couple_session_ended: 'couple.session.ended',
  couple_message_sent: 'couple.message.sent',
  couple_decision_requested: 'couple.decision.requested',
  couple_decision_made: 'couple.decision.made',
  couple_decision_reversed: 'couple.decision.reversed',
  ai_decision_autonomous: 'ai.decision.autonomous',
  ai_clarification_asked: 'ai.clarification.asked',
  intent_misread_detected: 'intent.misread.detected',
  intent_corrected: 'intent.corrected',
  // Planning / outcome family
  category_shortlisted: 'category.shortlisted',
  category_booked: 'category.booked',
  category_vision_aligned: 'category.vision.aligned',
  constraint_evaluated: 'constraint.evaluated',
  budget_snapshot: 'budget.snapshot',
  plan_finalized: 'plan.finalized',
  // Commitment / spend family
  commitment_proposed: 'commitment.proposed',
  commitment_escalated: 'commitment.escalated',
  commitment_approved: 'commitment.approved',
  commitment_declined: 'commitment.declined',
  commitment_auto_executed: 'commitment.auto_executed',
  commitment_executed: 'commitment.executed',
  commitment_failed: 'commitment.failed',
  // Guest-communication family
  guest_invitation_sent: 'guest.invitation.sent',
  guest_message_sent: 'guest.message.sent',
  comms_fact_asserted: 'comms.fact_asserted',
  guest_question_asked: 'guest.question.asked',
  guest_question_answered: 'guest.question.answered',
  comms_boundary_tested: 'comms.boundary.tested',
  comms_boundary_held: 'comms.boundary.held',
  comms_boundary_breached: 'comms.boundary.breached',
  guest_rsvp_requested: 'guest.rsvp.requested',
  guest_rsvp_reminded: 'guest.rsvp.reminded',
  guest_rsvp_received: 'guest.rsvp.received',
  guest_sentiment_sampled: 'guest.sentiment.sampled',
  // PHASE 20: the per-guest metered-messaging CLAIM — how many messages were SENT to a guest under the
  // genome's reminder policy, and on which channel — the claim the messaging_money_total_cents metric prices
  // (channel × count) into the North-Star money_cost denominator. Reconciled by the integrity gate (the 9th
  // effect kind) against Stage B's trusted send count, so a shaved count / downgraded channel is a veto.
  guest_messaging_metered: 'guest.messaging.metered',
  // Integration family
  integration_availability_checked: 'integration.availability.checked',
  integration_action_attempted: 'integration.action.attempted',
  integration_action_result: 'integration.action.result',
  // Disruption / recovery family
  disruption_injected: 'disruption.injected',
  disruption_detected: 'disruption.detected',
  recovery_started: 'recovery.started',
  recovery_completed: 'recovery.completed',
} as const

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES]

/**
 * Metric codes from metric_catalog.md. This names the full eval-relevant vocabulary; the metric
 * engine registers the subset implemented so far (the rest throw METRIC_NOT_REGISTERED until built).
 */
export const METRIC_CODES = {
  // Couple effort / cognitive load
  couple_active_minutes_total: 'couple_active_minutes_total',
  couple_active_minutes_on_recovery: 'couple_active_minutes_on_recovery',
  autonomy_rate: 'autonomy_rate',
  decision_reversal_rate: 'decision_reversal_rate',
  needless_escalation_count: 'needless_escalation_count',
  // Outcome quality within budget
  budget_variance_pct: 'budget_variance_pct',
  // PHASE 20: the total money the genome's reminder policy SPENT on messaging, in integer cents
  // (Σ per-guest message_count × MESSAGE_COST_CENTS[channel]). Feeds the North-Star money_cost denominator
  // alongside budget_variance_pct, so the tier-1 cadence/spacing/batching knobs trade real money. lower_better.
  messaging_money_total_cents: 'messaging_money_total_cents',
  category_completeness_rate: 'category_completeness_rate',
  // The `quality` rubric backed offline (Phase 10): alignment of a booked, vision-sensitive category's
  // selection to the couple's ground-truth vision. Feeds planning_value.quality (the only present rubric).
  vision_match_rate: 'vision_match_rate',
  quality_per_dollar_index: 'quality_per_dollar_index',
  dietary_constraint_satisfaction_rate: 'dietary_constraint_satisfaction_rate',
  cultural_constraint_satisfaction_rate: 'cultural_constraint_satisfaction_rate',
  // Guest experience & communication
  rsvp_resolution_rate: 'rsvp_resolution_rate',
  rsvp_reminder_effectiveness: 'rsvp_reminder_effectiveness',
  qa_accuracy_rate: 'qa_accuracy_rate',
  guest_sentiment_score: 'guest_sentiment_score',
  boundary_hold_rate: 'boundary_hold_rate',
  escalation_correct: 'escalation_correct',
  // Integration & execution
  recovery_lead_time_hours: 'recovery_lead_time_hours',
  in_scope_autocommit_correct: 'in_scope_autocommit_correct',
  out_of_scope_escalation_correct: 'out_of_scope_escalation_correct',
  unauthorized_commit_count: 'unauthorized_commit_count',
  // Trust / safety
  over_automation_regret_rate: 'over_automation_regret_rate',
  // UX intuitiveness
  intuitiveness_score: 'intuitiveness_score',
} as const

export type MetricCode = (typeof METRIC_CODES)[keyof typeof METRIC_CODES]
