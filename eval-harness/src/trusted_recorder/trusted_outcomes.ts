/**
 * The shapes the trusted recorder authors — the out-of-band record of what the product's effects
 * ACTUALLY did in the sandbox, written by the harness, never by the product.
 *
 * Every field here is TRUSTED-AUTHORED (telemetry/README.md "Integrity"). The product emits its own
 * telemetry events as CLAIMS about these same effects; those claims are diffed against these records
 * by the integrity gate, but they never set a field here. The distinction between "what the sandbox
 * observed" (these types) and "what the product said" (telemetry payloads) is the whole firewall.
 *
 * related: trusted_recorder.ts, gates/integrity_gate.ts.
 */

import { type Channel } from '@wedding-planner/shared'
import {
  type CategoryBookingStatus,
  type CoupleSessionReason,
  type QaAction,
  type QaAnswerableBy,
} from '@wedding-planner/telemetry'

/** What the harness's sandbox observed for one commitment (money/binding) effect. */
export interface TrustedCommitmentRecord {
  readonly commitment_id: string
  /**
   * The category or item this commitment is for (e.g. 'florals' or an item id), matched against an
   * opted_in_scope.applies_to by the SPEND gate. Trusted-observed, so the gate decides authorization
   * from the real category, not the product's claimed scope. Null means the recorder did not capture
   * a category — the SPEND gate then matches no scope (fail-safe: such an auto-commit is unauthorized).
   * Recorder-authored only; there is no product-claim path that any gate honors, so it is not part of
   * the integrity gate's field diff.
   */
  readonly applies_to_ref: string | null
  readonly cost_cents: number
  readonly refundable: boolean
  /** The opted_in_scope the product CLAIMS authorized an auto-execution, or null. The SPEND gate does
   * not trust this — it independently re-derives authorization from the couple's opted_in_scopes. */
  readonly scope_id: string | null
  /** Whether the product auto-executed this without awaiting approval (sandbox-observed). */
  readonly auto_executed: boolean
  /** Sandbox truth: did the binding action actually confirm. */
  readonly verified: boolean
  /** A genuine couple approval the recorder observed before this effect, or null if none. */
  readonly approved_by_event_id: string | null
  /** Trusted cumulative committed spend AFTER this effect — computed by the recorder, not supplied. */
  readonly running_committed_cents: number
}

/**
 * The input to record a commitment effect. The running total is computed by the recorder, and
 * applies_to_ref defaults to null when the caller omits it.
 */
export type RecordCommitmentInput = Omit<
  TrustedCommitmentRecord,
  'running_committed_cents' | 'applies_to_ref'
> & { readonly applies_to_ref?: string | null }

/** The status an external action actually resolved to in the sandbox. */
export type VerifiedStatus = 'attempted' | 'confirmed' | 'failed'

/** What the harness's sandbox observed for one external (booking/send) integration action. */
export interface TrustedIntegrationActionRecord {
  readonly action_id: string
  readonly integration_id: string
  /** Resource/slot identifier, used to detect double-booking. */
  readonly target_ref: string
  readonly method: string
  /** Sandbox truth: what the real (sandboxed) integration call actually returned. */
  readonly verified_status: VerifiedStatus
  readonly idempotency_key: string | null
  readonly availability_age_seconds: number | null
}

export type RecordIntegrationActionInput = TrustedIntegrationActionRecord

/**
 * What the harness independently observed about one guest's RSVP RESOLUTION (Phase 4b). The product
 * claims resolutions via `guest.rsvp.received`; this is the trusted truth of which guests ACTUALLY
 * resolved and how. Authored by Stage B from scenario ground truth + the trusted genome policy alone —
 * never from the product's claims. Only ACTUAL resolutions are recorded (like commitments): a claimed
 * resolution with no record here is a forge, and a record here with no claim is a suppression.
 *
 * This is the trusted backing for the `rsvp_resolution_rate` numerator, which the scorer computes over
 * the CLAIMED event stream — so the integrity gate can veto a forged resolution that would otherwise
 * inflate the North Star (the Phase-4b metric-reads-claims P0). Resolution is reconciled as ONE concept
 * keyed on guest_id regardless of cause; `resolved_via` is provenance only, never a reconciliation seam.
 */
export interface TrustedRsvpOutcomeRecord {
  readonly guest_id: string
  /** The status the guest actually gave; the gate field-diffs the claimed rsvp_status against this. */
  readonly rsvp_status: 'yes' | 'no'
  /** Provenance of the resolution: AI reminders, or the couple personally (escalate-to-couple). */
  readonly resolved_via: 'reminder' | 'couple'
}

export type RecordRsvpOutcomeInput = TrustedRsvpOutcomeRecord

/**
 * What the harness observed for one couple-attention session the planner consumed by ESCALATING to the
 * couple (Phase 4b, generalized Phase 9). Each escalation consumes the couple's scarce attention — the
 * cost side of the escalate-to-couple tradeoff — and feeds `couple_active_minutes_total → effort_cost`
 * (the North Star denominator), which the scorer SUMS over CLAIMED `couple.session.ended` events
 * regardless of reason. Keyed by the composite `(session_reason, about_id)` (both harness-derivable,
 * never a product-chosen opaque id) so a claimed session joins to its trusted cost AND one `about_id`
 * (e.g. a guest) can carry more than one escalation reason without colliding. The gate field-diffs
 * `active_seconds` so partial under-reporting is a veto, not a skip; a reason-relabel misses the join
 * (forged) and leaves the trusted session unclaimed (suppressed). Authored by Stage B from the genome
 * policy + ground truth alone.
 *
 * `about_id` is the escalation TARGET, by reason: a guest_id (`rsvp_escalation`), a question_id
 * (`qa_escalation`), or a category_id (`booking_approval`).
 */
export interface TrustedCoupleSessionRecord {
  /** Why the couple spent attention — the join-key discriminator (Phase 9). */
  readonly session_reason: CoupleSessionReason
  /** The escalation target this session was about — guest_id / question_id / category_id (the join key). */
  readonly about_id: string
  /** The true couple attention spent on this escalation, in seconds (the cost the gate reconciles). */
  readonly active_seconds: number
}

export type RecordCoupleSessionInput = TrustedCoupleSessionRecord

/**
 * What the harness independently observed about one guest's SENTIMENT under the genome's reminder policy
 * (Phase 6). The product claims a per-guest score via `guest.sentiment.sampled`; the scorer means those
 * CLAIMED scores into `guest_sentiment_score` (half of the `guest_experience` North-Star component). This
 * is the trusted backing — the honest score Stage B re-derives from `honestSentimentScore` (the SHARED
 * fact) on persona ground truth + the trusted genome policy alone, never from the product's claim. One
 * is recorded per guest (Stage A samples every guest unconditionally), so the integrity gate covers all
 * three forges: an inflated score (field_mismatch), a dropped low-sentiment sample (suppressed_effect —
 * which raises the mean), and a phantom-happy guest (forged_effect).
 *
 * Note this backs a GRADER input (the North-Star numerator), not a VETO-GATE input — so it extends the
 * firewall the way Phase 4b did for resolution/cost, without changing the integrity-gate completeness
 * invariant (which concerns the fields veto gates read). Phase 5's batching ENLARGED this claimed value
 * (the comfort-consolidation upside), which is why it is reconciled now (escalation-forge-detection D7).
 */
export interface TrustedSentimentObservationRecord {
  readonly guest_id: string
  /** The honest sentiment score in [0,1]; the gate field-diffs the claimed sentiment_score against this. */
  readonly sentiment_score: number
}

export type RecordSentimentObservationInput = TrustedSentimentObservationRecord

/**
 * What the harness independently observed about the product's handling of ONE scripted guest question
 * (Phase 7). The product claims its handling via `guest.question.answered` (action_taken +
 * answerable_by_expected); the scorer derives `qa_accuracy_rate` over the CLAIMED stream
 * (correct = action_taken matches the required action for the question's nature). This is the trusted
 * backing — Stage B re-derives, from persona ground truth + the trusted genome policy ALONE, both the
 * question's true `answerable_by` and the honest `action_taken` (via `honestQaAction`), never from the
 * product's claim. One is recorded per scripted question, keyed by the composite (guest_id, question_id).
 *
 * The honest action is GENOME-DEPENDENT: a `requires_couple` question is handled correctly only by
 * ESCALATING, which requires the tier-2 `autonomy_threshold` (escalation consumes couple attention —
 * the commitment_autonomy surface). A tier-1 genome honestly ANSWERS it (incorrect). This is what makes
 * the firewall load-bearing: a tier-1 candidate that CLAIMS it escalated (qa correct) without the couple
 * cost diverges from this trusted action and is vetoed. The gate field-diffs BOTH `action_taken` and
 * `answerable_by_expected` against this record, so a relabel forge (calling a couple-question
 * AI-answerable) is caught too.
 *
 * Like sentiment (Phase 6), this backs a GRADER input (the North-Star numerator), not a VETO-GATE
 * input — it extends the firewall without changing the integrity-gate completeness invariant.
 */
export interface TrustedQaOutcomeRecord {
  readonly guest_id: string
  readonly question_id: string
  /** The question's true nature (persona ground truth); the gate diffs the claimed value against this. */
  readonly answerable_by: QaAnswerableBy
  /** The honest action under the trusted genome policy; the gate diffs the claimed action_taken against this. */
  readonly action_taken: QaAction
}

export type RecordQaOutcomeInput = TrustedQaOutcomeRecord

/**
 * What the harness independently observed about the product's handling of ONE required category (Phase 8)
 * — the FIRST plan-side trusted record (every prior record is a guest-side effect). The product claims its
 * booking via `category.booked` (booking_status); the scorer derives `category_completeness_rate` over the
 * CLAIMED stream (complete = booking_status==='booked'). This is the trusted backing — Stage B re-derives,
 * from the scenario's `required_categories` ground truth + the trusted genome policy ALONE, the honest
 * `booking_status` (via `honestCategoryStatus`), never from the product's claim. One is recorded per
 * required category, keyed by `category_id`.
 *
 * The honest status is GENOME-DEPENDENT: a `requires_couple_approval` category is `booked` only by a
 * genome that can escalate (the tier-2 `autonomy_threshold` — the SAME commitment_autonomy surface Q&A
 * escalation uses); a tier-1 genome honestly `deferred`s it. This is what makes the firewall load-bearing:
 * a tier-1 candidate that CLAIMS `booked` (completeness up) without the couple commitment cost diverges
 * from this trusted `deferred` → field_mismatch → veto. Only `booking_status` is field-diffed: the metric
 * reads category_id (join key) + booking_status, and never `requires_couple_approval`, so there is no
 * relabel surface (unlike Q&A, whose metric reads `answerable_by`). `category` is provenance only.
 *
 * Like sentiment (Phase 6) and Q&A (Phase 7), this backs a GRADER input (the North-Star numerator), not a
 * VETO-GATE input — it extends the firewall without changing the integrity-gate completeness invariant.
 */
export interface TrustedCategoryBookingRecord {
  readonly category_id: string
  /** The category this booking is for (provenance; the metric does not read it). */
  readonly category: string
  /** The honest status under the trusted genome policy; the gate diffs the claimed booking_status against this. */
  readonly booking_status: CategoryBookingStatus
}

export type RecordCategoryBookingInput = TrustedCategoryBookingRecord

/**
 * What the harness independently observed about the product's VISION ALIGNMENT for one booked,
 * vision-sensitive category (Phase 10) — the trusted backing for the claimed `vision_match_rate` (the only
 * `planning_value.quality` rubric backed offline). The product claims its alignment via
 * `category.vision.aligned` (vision_match_score); the scorer means it into `vision_match_rate`. This is the
 * trusted backing — Stage B re-derives, from the trusted genome's CONSULT capability ALONE (via the shared
 * `honestVisionMatch` fact), the honest score, never from the product's claim. One is recorded per booked
 * vision-sensitive category, keyed by `category_id`.
 *
 * The honest score is GENOME-DEPENDENT and ORTHOGONAL to completeness: a vision-sensitive category is
 * aligned to the couple's vision (`ALIGNED`, 1.0) only by a genome that can CONSULT the couple (the tier-2
 * `autonomy_threshold` — the SAME commitment_autonomy surface category/Q&A escalation uses, consuming a
 * `vision_consult` couple session); a tier-1 genome books with a `DEFAULT` selection (0.5). The category is
 * booked EITHER way (vision-sensitivity is independent of `requires_couple_approval`), so this is a genuine
 * orthogonal value axis, not a re-skin of completeness. This is what makes the firewall load-bearing: a
 * tier-1 candidate that CLAIMS the aligned score it cannot earn diverges from this trusted `DEFAULT` →
 * field_mismatch → veto. Only `vision_match_score` is field-diffed (the metric reads category_id + score).
 *
 * Like sentiment/Q&A/category, this backs a GRADER input (the North-Star numerator), not a VETO-GATE
 * input — it extends the firewall without changing the integrity-gate completeness invariant. The COST side
 * (the `vision_consult` couple session) rides Phase 9's per-`(reason, about_id)` couple-session
 * reconciliation unchanged — no new gate code for the cost.
 */
export interface TrustedVisionAlignmentRecord {
  readonly category_id: string
  /** The honest [0,1] alignment under the trusted genome policy; the gate diffs the claimed score against this. */
  readonly vision_match_score: number
}

export type RecordVisionAlignmentInput = TrustedVisionAlignmentRecord

/**
 * What the harness independently observed about the MESSAGING the product sent ONE guest under the genome's
 * reminder policy (Phase 20) — the trusted backing for the claimed `messaging_money_total_cents`, which feeds
 * the North-Star money_cost DENOMINATOR. The product claims its per-guest send via `guest.messaging.metered`
 * (channel + message_count); the scorer prices the CLAIMED stream (`Σ message_count × MESSAGE_COST_CENTS
 * [channel]`). This is the trusted backing — Stage B re-derives, from persona ground truth + the trusted
 * genome policy ALONE (via the shared `honestMessagesSent` fact + the guest's `preferred_channel`), both the
 * honest send count and the channel, never from the product's claim. One is recorded per guest WITH SENDS
 * (the `honestMessagesSent > 0` guard, identical on both stages), keyed by `guest_id`.
 *
 * money_cost is LOWER-better (a denominator term), so the incentive is to UNDER-report. The gate field-diffs
 * BOTH fields (each `skipWhenClaimAbsent: false`): `message_count` defends the QUANTITY (a shaved count is a
 * veto) and `channel` defends the PRICE BASIS (a downgrade to a cheaper channel is a veto). A SUPPRESSED claim
 * (drop a guest's send → lower sum) is caught by enumerating `allMessagingSpends()`; a FORGED claim (a guest
 * the trusted record never observed, e.g. a 0-send guest) is caught by the missing trusted record. Like
 * couple_session this is a SUMMED COST, so there is NO duplicate-as-forge arm (a duplicate ADDS cost —
 * self-harm; the recorder is append-only-per-guest anyway). Like sentiment/Q&A/category/vision it backs a
 * GRADER input (the North-Star denominator), not a VETO-GATE input — it extends the firewall without changing
 * the integrity-gate completeness invariant.
 *
 * `channel` is a pure SCENARIO fact (`guest.contact.preferred_channel`), genome-free, so both stages read it
 * identically and the field-diff never false-positives. TRIPWIRE: a future channel-choosing genome knob makes
 * channel genome-dependent and reopens this reasoning.
 */
export interface TrustedMessagingSpendRecord {
  readonly guest_id: string
  /** The channel the guest is reachable on (`preferred_channel`); the gate diffs the claimed channel against this. */
  readonly channel: Channel
  /** The honest count of messages actually SENT to this guest; the gate diffs the claimed message_count against this. */
  readonly message_count: number
}

export type RecordMessagingSpendInput = TrustedMessagingSpendRecord

/** Grader-side determination of whether one hard constraint is satisfied by the final plan. */
export interface TrustedConstraintDetermination {
  readonly constraint_id: string
  readonly constraint_type:
    | 'date'
    | 'guest_count'
    | 'budget'
    | 'allergy'
    | 'accessibility'
    | 'cultural'
    | 'religious'
    | 'dietary'
    | 'other'
  /** Computed grader-side from the persona's hard_constraints ground truth — never set by the product. */
  readonly satisfied: boolean
  readonly severity: 'fatal' | 'serious' | 'moderate'
  readonly plan_element_ref: string | null
}

export type RecordConstraintDeterminationInput = TrustedConstraintDetermination

/** One factual claim captured at the send boundary (the actual value sent to the guest). */
export interface TrustedFactAssertion {
  readonly fact_id: string
  readonly fact_type: string
  /** The value actually sent to the guest, captured out-of-band — fact-checked against the booked plan. */
  readonly asserted_value: string
}

/**
 * The trusted capture of one guest-facing message — what was ACTUALLY sent, intercepted at the send
 * boundary (gate_checks.md: COMMS gates compute over captured sent content, not product events). The
 * grader-side determinations (mentioned secret tags, disclosed other-guest ids) are authored here.
 */
export interface TrustedGuestMessageRecord {
  readonly message_id: string
  readonly recipient_guest_id: string
  readonly fact_assertions: readonly TrustedFactAssertion[]
  /** Registered surprise tags this message reveals/hints at (grader-determined). Non-empty = leak. */
  readonly reveals_secret_tags: readonly string[]
  /** Other guests whose private data this message discloses (grader-determined). Non-empty = mis-seg. */
  readonly discloses_guest_ids: readonly string[]
}

export type RecordGuestMessageInput = TrustedGuestMessageRecord
