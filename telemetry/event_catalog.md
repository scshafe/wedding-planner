# Event Catalog

Every telemetry event, grouped by family. All conform to `schemas/event_envelope_schema.json`.
The "$def / payload" column names the payload contract in `schemas/event_payloads_schema.json`
where one exists; otherwise the key fields are listed and should be materialized as the product
is built. "Feeds" lists the metrics (`metric_catalog.md`) and gates
(`../eval-harness/rubrics/gate_checks.md`) computed from the event.

## Couple-interaction family (`couple.*`, `ai.decision.*`, `intent.*`)
Effort, decisions, autonomy, intuitiveness.

| event_name | actor | $def / key payload | feeds |
|---|---|---|---|
| `couple.session.started` | couple | `{session_id}` | couple_active_minutes_total |
| `couple.session.ended` | couple | `{session_id, active_seconds}` | couple_active_minutes_total, couple_active_minutes_on_recovery |
| `couple.message.sent` | couple | `{message_id}` (text `[REDACTED]`) | intuitiveness (transcript) |
| `couple.decision.requested` | ai | `couple_decision_payload` (outcome=deferred until made) | autonomy_rate (denominator), needless_escalation_count |
| `couple.decision.made` | couple | `couple_decision_payload` | decision_reversal_rate, couple effort (latency) |
| `couple.decision.reversed` | couple | `couple_decision_payload` (reverses_decision_id set) | decision_reversal_rate |
| `ai.decision.autonomous` | ai | `couple_decision_payload` (was_autonomous=true) | autonomy_rate (numerator), over_automation_regret_rate |
| `ai.clarification.asked` | ai | `{clarification_id, topic}` | clarification_efficiency (intuitiveness) |
| `intent.misread.detected` | system | `{decision_id}` | recovery_from_misread (intuitiveness) |
| `intent.corrected` | couple | `{decision_id}` | recovery_from_misread (intuitiveness) |

## Planning / outcome family (`category.*`, `constraint.*`, `budget.*`, `plan.*`)
Completeness, budget, constraint satisfaction.

| event_name | actor | $def / key payload | feeds |
|---|---|---|---|
| `category.shortlisted` | ai | `{vendor_category, option_count}` | (process visibility) |
| `category.booked` | ai | `{category_id, category, booking_status}` | category_completeness_rate |
| `category.vision.aligned` | ai | `{category_id, vision_match_score}` | vision_match_rate (→ planning_value.quality) |
| `constraint.evaluated` | system | `constraint_evaluated_payload` | CONSTRAINT.HARD_VIOLATED, dietary_/cultural_constraint_satisfaction_rate |
| `budget.snapshot` | system | `{committed_cents, forecast_cents, budget_cents}` | budget_variance_pct, BUDGET.CEILING_EXCEEDED |
| `plan.finalized` | system | `{booked_categories[], total_spend_cents, weather_contingency}` | category_completeness_rate, golden_expected_outcomes, quality_per_dollar_index |

## Commitment / spend family (`commitment.*`)
The spend-authorization model. All use `commitment_payload`; `status` distinguishes them.

| event_name | actor | status | feeds |
|---|---|---|---|
| `commitment.proposed` | ai | proposed | (denominator for spend metrics) |
| `commitment.escalated` | ai | escalated (+escalation_reason) | out_of_scope_escalation_correct, needless_escalation_count |
| `commitment.approved` | couple | approved | authorizes a subsequent executed |
| `commitment.declined` | couple | declined | — |
| `commitment.auto_executed` | ai | auto_executed (+scope_id) | in_scope_autocommit_correct, autonomy_rate |
| `commitment.executed` | system | executed (+approved_by_event_id, verified) | SPEND.UNAUTHORIZED_COMMIT, unauthorized_commit_count, BUDGET.CEILING_EXCEEDED |
| `commitment.failed` | system | failed | INTEGRATION.SILENT_FAILURE |

## Guest-communication family (`guest.*`, `comms.*`)
Comms, RSVP, Q&A, boundaries.

| event_name | actor | $def / key payload | feeds |
|---|---|---|---|
| `guest.invitation.sent` | ai | `{guest_id, channel, language}` | comms_quality (language_correctness) |
| `guest.message.sent` | ai | `{guest_id, channel, language}` (text `[REDACTED]`) | comms_quality, COMMS.MIS_SEGMENTATION |
| `comms.fact_asserted` | ai | `comms_fact_asserted_payload` | COMMS.FALSE_FACT_TO_GUEST, qa_accuracy_rate |
| `guest.question.asked` | guest | `{question_id, guest_id}` (text `[REDACTED]`) | qa coverage |
| `guest.question.answered` | ai | `guest_question_answered_payload` | qa_accuracy_rate, escalation_correct |
| `comms.boundary.tested` | guest | `{boundary_type, guest_id}` | boundary_hold_rate (denominator) |
| `comms.boundary.held` | ai | `{boundary_type, guest_id}` | boundary_hold_rate, COMMS.SURPRISE_LEAK, COMMS.MIS_SEGMENTATION |
| `comms.boundary.breached` | ai | `{boundary_type, guest_id}` | COMMS.SURPRISE_LEAK, COMMS.MIS_SEGMENTATION, SPEND.UNAUTHORIZED_COMMIT (plus-one) |
| `guest.rsvp.requested` | ai | `{guest_id}` | rsvp_resolution_rate (denominator) |
| `guest.rsvp.reminded` | ai | `{guest_id, reminder_index}` | rsvp_reminder_effectiveness |
| `guest.rsvp.received` | guest | `{guest_id, rsvp_status, party_size}` | rsvp_resolution_rate, rsvp_reminder_effectiveness |
| `guest.sentiment.sampled` | system | `{guest_id, sentiment_score}` | guest_sentiment_score |

## Integration family (`integration.*`)
3rd-party execution and reliability.

| event_name | actor | $def / key payload | feeds |
|---|---|---|---|
| `integration.availability.checked` | ai | `{integration_id, availability_age_seconds}` | INTEGRATION.DOUBLE_BOOK (staleness) |
| `integration.action.attempted` | ai | `integration_action_result_payload` (claimed=attempted) | (denominator) |
| `integration.action.result` | system | `integration_action_result_payload` | INTEGRATION.SILENT_FAILURE, INTEGRATION.DOUBLE_BOOK |

## Disruption / recovery family (`disruption.*`, `recovery.*`)
Adversarial recovery (vendor cancels, price jumps).

| event_name | actor | $def / key payload | feeds |
|---|---|---|---|
| `disruption.injected` | system | `{event_type, at_phase}` (eval) | recovery_lead_time_hours (start) |
| `disruption.detected` | system | `{event_type}` (production) | recovery_lead_time_hours (start) |
| `recovery.started` | ai | `{disruption_event_id}` | recovery_lead_time_hours |
| `recovery.completed` | ai | `{disruption_event_id, vendor_category}` | recovery_lead_time_hours, category_completeness_rate |

## Emission rules

- Emit at the moment of the action, with the real outcome. **No silent fallbacks** — a failed
  integration emits `integration.action.result` with `verified_status=failed`, never a
  fabricated success (that is exactly what `INTEGRATION.SILENT_FAILURE` catches).
- Free-text that may contain PII is `[REDACTED]`; graders read ground truth from the persona.
- One commitment's whole lifecycle shares a `commitment_id`; one guest question shares a
  `question_id` across asked/answered. Correlation is by id, not by ordering.
