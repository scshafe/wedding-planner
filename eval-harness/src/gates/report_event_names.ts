import { EVENT_NAMES } from '@wedding-planner/telemetry'

/**
 * @canonical report_event_names -- the single definition of "the product reported this effect".
 *
 * The integrity gate's suppression check and any sibling gate that reasons about whether the product
 * reported an effect MUST import these sets, so the two readers of the telemetry channel cannot drift
 * apart (the "reader-set seam" the security review flagged: if the detector scans one set of
 * event-names and a gate keys on another, a product can satisfy the gate while staying invisible to
 * suppression detection).
 *
 * The commitment set is the COMPLETE set of commitment-outcome reports — executed, auto-executed, AND
 * failed — so a real effect reported under any legitimate outcome name counts as "reported" (and a
 * lie within that report is then caught by the field-level diff, not missed by suppression).
 *
 * related: gates/integrity_gate.ts, gates/spend_gate.ts (Step 8), gates/integration_gates.ts (Step 8).
 */
export const COMMITMENT_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.commitment_executed,
  EVENT_NAMES.commitment_auto_executed,
  EVENT_NAMES.commitment_failed,
])

export const INTEGRATION_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.integration_action_result,
])

/**
 * PHASE 4b. The product reports an RSVP RESOLUTION via `guest.rsvp.received` — the claim the
 * `rsvp_resolution_rate` numerator counts. The integrity gate reconciles every such claim (by
 * guest_id) against the trusted RSVP-outcome record, so a forged resolution (reminder- OR couple-
 * attributed) cannot inflate the numerator unchecked. Resolution is ONE concept; the cause-label is
 * never a reconciliation seam (doddy P0-1).
 */
export const RSVP_RECEIVED_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.guest_rsvp_received,
])

/**
 * PHASE 4b. The product reports a couple-attention session (the escalate-to-couple COST) via
 * `couple.session.ended` — the claim the `couple_active_minutes_total → effort_cost` denominator sums.
 * The integrity gate reconciles each (by the escalated guest_id it carries) against the trusted
 * couple-session record, field-diffing `active_seconds` so partial under-reporting is a veto.
 */
export const COUPLE_SESSION_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.couple_session_ended,
])

/**
 * PHASE 6. The product reports a per-guest SENTIMENT sample via `guest.sentiment.sampled` — the claim
 * the `guest_sentiment_score` metric means over (half of the `guest_experience` North-Star component).
 * The integrity gate reconciles each (by guest_id) against the trusted sentiment observation Stage B
 * authors per guest, field-diffing `sentiment_score` so an inflated score is a veto and a DROPPED sample
 * (which would raise the mean over the remaining samples) is caught as a suppression. Batching's comfort-
 * consolidation upside (Phase 5) feeds this metric, which is why it is now reconciled (4b deferral D7).
 */
export const SENTIMENT_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.guest_sentiment_sampled,
])

/**
 * PHASE 7. The product reports its handling of a scripted guest question via `guest.question.answered`
 * — the claim the `qa_accuracy_rate` metric scores (correct = `action_taken` matches the required
 * action for `answerable_by_expected`). The integrity gate reconciles each (by the composite
 * guest_id|question_id) against the trusted Q&A outcome Stage B authors per question, field-diffing BOTH
 * `action_taken` (so a tier-1 candidate that CLAIMS it escalated a requires_couple question is vetoed)
 * and `answerable_by_expected` (so a relabel forge — calling a couple-question AI-answerable — is
 * caught), with a duplicate-claim and a suppression check (dropping a wrong answer would raise the rate).
 */
export const QA_ANSWERED_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.guest_question_answered,
])
