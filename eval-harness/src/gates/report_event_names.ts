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

/**
 * PHASE 8. The product reports its booking of a required category via `category.booked` — the claim the
 * `category_completeness_rate` metric scores (complete = `booking_status === 'booked'`). The integrity
 * gate reconciles each (by `category_id`) against the trusted category booking Stage B authors per
 * required category, field-diffing `booking_status` (so a tier-1 candidate that CLAIMS it booked an
 * approval-required category — honest `deferred` — without the couple commitment cost is vetoed), with a
 * duplicate-claim check (a per-category rate is gamed by re-emitting a `booked` claim) and a suppression
 * check (dropping a `deferred` category would raise the claims-only rate). The join key `category_id`
 * defends the denominator; `booking_status` defends the numerator; `requires_couple_approval` is never
 * claimed (the metric does not read it) so there is no relabel surface to diff.
 */
export const CATEGORY_BOOKED_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.category_booked,
])

/**
 * PHASE 10. The product reports its VISION ALIGNMENT for a booked, vision-sensitive category via
 * `category.vision.aligned` — the claim the `vision_match_rate` metric means (the only
 * `planning_value.quality` rubric backed offline). The integrity gate reconciles each (by `category_id`)
 * against the trusted vision alignment Stage B authors per booked vision-sensitive category, field-diffing
 * `vision_match_score` (so a tier-1 candidate that CLAIMS the aligned 1.0 it cannot earn — honest 0.5,
 * it could not consult — without the `vision_consult` couple cost is vetoed), with a duplicate-claim check
 * (a per-category mean is gamed by re-emitting a high claim) and a suppression check. The join key
 * `category_id` defends the denominator; `vision_match_score` defends the numerator. ORTHOGONAL to
 * `category.booked` (the completeness axis) — a separate event + effect kind. The COST side (the
 * `vision_consult` couple session) rides Phase 9's couple-session reconciliation, NOT this set.
 */
export const VISION_ALIGNED_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.category_vision_aligned,
])

/**
 * PHASE 20. The product reports the MESSAGING it sent one guest via `guest.messaging.metered` — the claim the
 * `messaging_money_total_cents` metric prices (`Σ message_count × MESSAGE_COST_CENTS[channel]`) into the
 * North-Star money_cost DENOMINATOR. The integrity gate reconciles each (by `guest_id`) against the trusted
 * messaging spend Stage B authors per guest-with-sends, field-diffing BOTH `message_count` (the quantity — a
 * shaved count lowers the summed cost) and `channel` (the price basis — a downgrade to a cheaper channel
 * lowers it), each `skipWhenClaimAbsent:false`. money_cost is LOWER-better, so SUPPRESSION (drop a guest's
 * send) is the highest-yield attack — caught by enumerating `allMessagingSpends()`. The join key `guest_id`
 * defends the denominator (forged/suppressed); the two fields defend the priced quantity. Summed cost ⇒ NO
 * duplicate-as-forge arm (a duplicate ADDS cost). Backs a GRADER input (the denominator), not a VETO-GATE input.
 */
export const MESSAGING_METERED_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.guest_messaging_metered,
])
