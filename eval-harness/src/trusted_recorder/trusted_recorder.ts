import { deepFreeze } from '@wedding-planner/shared'
import { type CoupleSessionReason } from '@wedding-planner/telemetry'

import { EvalHarnessError } from '../eval_harness_error'
import {
  type RecordCategoryBookingInput,
  type RecordCommitmentInput,
  type RecordConstraintDeterminationInput,
  type RecordCoupleSessionInput,
  type RecordGuestMessageInput,
  type RecordIntegrationActionInput,
  type RecordQaOutcomeInput,
  type RecordRsvpOutcomeInput,
  type RecordSentimentObservationInput,
  type TrustedCategoryBookingRecord,
  type TrustedCommitmentRecord,
  type TrustedConstraintDetermination,
  type TrustedCoupleSessionRecord,
  type TrustedGuestMessageRecord,
  type TrustedIntegrationActionRecord,
  type TrustedQaOutcomeRecord,
  type TrustedRsvpOutcomeRecord,
  type TrustedSentimentObservationRecord,
} from './trusted_outcomes'

/**
 * @canonical trusted_recorder -- the integrity boundary; the harness's out-of-band record of the
 * product's ACTUAL (sandboxed) effects, authored by the harness and never by the product.
 *
 * This is the project's #1 safety boundary (safety_and_governance.md §1, telemetry/README.md
 * "Integrity"). The veto gates read security-relevant ground truth from THIS recorder, not from the
 * product's self-reported telemetry. The firewall therefore protects the gates' *inputs*, not just
 * their code: a product-only change can forge or suppress its own events, but it cannot reach into
 * this recorder.
 *
 * Three properties make that real, and are enforced here, not asserted:
 *  1. Single authorship — the only writers are the record* methods, the sandbox/harness interface.
 *     No method accepts a product-supplied value for a trusted field.
 *  2. Recorder-computed totals — running_committed_cents is computed cumulatively here, never taken
 *     from the product. The product cannot under-report the committed total to dodge BUDGET.
 *  3. Immutable, append-only records — each effect is recorded once and deep-frozen; a gate (or
 *     anything downstream) cannot mutate the trusted record it reads. After `seal()`, no further
 *     effect may be recorded, so a gate that has read `totalCommittedCents()` cannot have the total
 *     changed under it by a late record (a TOCTOU the gate runner closes by sealing before scoring).
 *
 * DEFERRED FEED-PATH INVARIANT (Phase 2, the highest-leverage thing to get right then): in Phase 1
 * the caller of record* IS the harness's sandbox, so the supplied values ARE trusted observations.
 * When the real interception layer is built, the value passed to `recordCommitment({ verified, ... })`
 * MUST come from the harness observing the sandboxed call return — never from anything the product
 * authored. The input type should be branded so a product-authored value cannot be passed by accident
 * ([[prod-trusted-evidence-channel]]); recorded as a later-phase contract change, not done here.
 *
 * related: trusted_outcomes.ts, gates/integrity_gate.ts, gates/report_event_names.ts, gates/* (all read here).
 */
/**
 * The composite key for a Q&A outcome. A guest can ask multiple questions, so the trusted record is
 * keyed by (guest_id, question_id). `JSON.stringify` of the tuple is collision-free and printable, so
 * distinct (guest, question) pairs never share a key. Callers reach the record via
 * `qaOutcome(guestId, questionId)`, so the key format stays internal to the recorder.
 */
function qaCompositeKey(guestId: string, questionId: string): string {
  return JSON.stringify([guestId, questionId])
}

/**
 * The composite key for a couple-attention session (Phase 9). One `about_id` (e.g. a guest) can carry
 * more than one escalation reason, so the trusted record is keyed by `(session_reason, about_id)`.
 * `JSON.stringify` of the tuple is collision-free and printable; the key format stays internal to the
 * recorder (callers reach a record via `coupleSession(reason, aboutId)`).
 */
function coupleSessionCompositeKey(reason: CoupleSessionReason, aboutId: string): string {
  return JSON.stringify([reason, aboutId])
}

export class TrustedRecorder {
  private readonly commitmentsById = new Map<string, TrustedCommitmentRecord>()
  private readonly integrationActionsById = new Map<string, TrustedIntegrationActionRecord>()
  private readonly constraintsById = new Map<string, TrustedConstraintDetermination>()
  private readonly guestMessagesById = new Map<string, TrustedGuestMessageRecord>()
  private readonly rsvpOutcomesByGuestId = new Map<string, TrustedRsvpOutcomeRecord>()
  private readonly coupleSessionsByCompositeKey = new Map<string, TrustedCoupleSessionRecord>()
  private readonly sentimentObservationsByGuestId = new Map<string, TrustedSentimentObservationRecord>()
  private readonly qaOutcomesByCompositeKey = new Map<string, TrustedQaOutcomeRecord>()
  private readonly categoryBookingsByCategoryId = new Map<string, TrustedCategoryBookingRecord>()
  private runningCommittedCents = 0
  private sealed = false

  /**
   * Record the sandbox-observed outcome of one commitment effect. The running committed total is
   * computed here (verified commitments add their cost) and stamped onto the frozen record. Throws
   * TRUSTED_RECORDER.DUPLICATE_EFFECT if this commitment was already recorded (append-only).
   */
  recordCommitment(input: RecordCommitmentInput): TrustedCommitmentRecord {
    this.assertNotSealed('commitment', input.commitment_id)
    if (this.commitmentsById.has(input.commitment_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Commitment ${input.commitment_id} was already recorded; the trusted record is append-only.`,
        { context: { commitment_id: input.commitment_id } },
      )
    }
    if (input.verified) {
      this.runningCommittedCents += input.cost_cents
    }
    const record = deepFreeze<TrustedCommitmentRecord>({
      ...input,
      applies_to_ref: input.applies_to_ref ?? null,
      running_committed_cents: this.runningCommittedCents,
    })
    this.commitmentsById.set(input.commitment_id, record)
    return record
  }

  /** Record the sandbox-observed outcome of one external integration action (booking/send). */
  recordIntegrationAction(input: RecordIntegrationActionInput): TrustedIntegrationActionRecord {
    this.assertNotSealed('integration', input.action_id)
    if (this.integrationActionsById.has(input.action_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Integration action ${input.action_id} was already recorded; the trusted record is append-only.`,
        { context: { action_id: input.action_id } },
      )
    }
    const record = deepFreeze<TrustedIntegrationActionRecord>({ ...input })
    this.integrationActionsById.set(input.action_id, record)
    return record
  }

  /** Record a grader-side determination of whether one hard constraint is satisfied by the plan. */
  recordConstraintDetermination(
    input: RecordConstraintDeterminationInput,
  ): TrustedConstraintDetermination {
    this.assertNotSealed('constraint', input.constraint_id)
    if (this.constraintsById.has(input.constraint_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Constraint ${input.constraint_id} was already evaluated; the trusted record is append-only.`,
        { context: { constraint_id: input.constraint_id } },
      )
    }
    const record = deepFreeze<TrustedConstraintDetermination>({ ...input })
    this.constraintsById.set(input.constraint_id, record)
    return record
  }

  /** Record the trusted capture of one guest-facing message (the actual content sent). */
  recordGuestMessage(input: RecordGuestMessageInput): TrustedGuestMessageRecord {
    this.assertNotSealed('guest_message', input.message_id)
    if (this.guestMessagesById.has(input.message_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Guest message ${input.message_id} was already recorded; the trusted record is append-only.`,
        { context: { message_id: input.message_id } },
      )
    }
    const record = deepFreeze<TrustedGuestMessageRecord>({
      ...input,
      fact_assertions: input.fact_assertions.map((fact) => ({ ...fact })),
      reveals_secret_tags: [...input.reveals_secret_tags],
      discloses_guest_ids: [...input.discloses_guest_ids],
    })
    this.guestMessagesById.set(input.message_id, record)
    return record
  }

  /**
   * Record the harness-observed RSVP resolution of one guest (Phase 4b). Append-only, one per guest.
   * Feeds the integrity gate's rsvp-outcome reconciliation (the trusted backing for the claimed
   * resolution numerator). Throws DUPLICATE_EFFECT if this guest already resolved.
   */
  recordRsvpOutcome(input: RecordRsvpOutcomeInput): TrustedRsvpOutcomeRecord {
    this.assertNotSealed('rsvp_outcome', input.guest_id)
    if (this.rsvpOutcomesByGuestId.has(input.guest_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Guest ${input.guest_id} already has a recorded RSVP outcome; the trusted record is append-only.`,
        { context: { guest_id: input.guest_id } },
      )
    }
    const record = deepFreeze<TrustedRsvpOutcomeRecord>({ ...input })
    this.rsvpOutcomesByGuestId.set(input.guest_id, record)
    return record
  }

  /**
   * Record the harness-observed couple-attention session one escalation consumed (Phase 4b, generalized
   * Phase 9). Append-only, one per `(session_reason, about_id)`. Feeds the integrity gate's couple-cost
   * reconciliation (the trusted backing for the claimed effort_cost denominator). Throws DUPLICATE_EFFECT
   * on a repeat for the same `(reason, about_id)`.
   */
  recordCoupleSession(input: RecordCoupleSessionInput): TrustedCoupleSessionRecord {
    const key = coupleSessionCompositeKey(input.session_reason, input.about_id)
    this.assertNotSealed('couple_session', key)
    if (this.coupleSessionsByCompositeKey.has(key)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Couple session ${input.session_reason}/${input.about_id} already recorded; the trusted record is append-only.`,
        { context: { session_reason: input.session_reason, about_id: input.about_id } },
      )
    }
    const record = deepFreeze<TrustedCoupleSessionRecord>({ ...input })
    this.coupleSessionsByCompositeKey.set(key, record)
    return record
  }

  /**
   * Record the harness-observed honest sentiment score for one guest (Phase 6). Append-only, one per
   * guest. Feeds the integrity gate's sentiment reconciliation (the trusted backing for the claimed
   * `guest_sentiment_score` numerator). Throws DUPLICATE_EFFECT on a repeat for the same guest.
   */
  recordSentimentObservation(input: RecordSentimentObservationInput): TrustedSentimentObservationRecord {
    this.assertNotSealed('guest_sentiment', input.guest_id)
    if (this.sentimentObservationsByGuestId.has(input.guest_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Guest ${input.guest_id} already has a recorded sentiment observation; the trusted record is append-only.`,
        { context: { guest_id: input.guest_id } },
      )
    }
    const record = deepFreeze<TrustedSentimentObservationRecord>({ ...input })
    this.sentimentObservationsByGuestId.set(input.guest_id, record)
    return record
  }

  /**
   * Record the harness-observed honest handling of one scripted guest question (Phase 7). Append-only,
   * one per (guest_id, question_id). Feeds the integrity gate's Q&A reconciliation (the trusted backing
   * for the claimed `qa_accuracy_rate`). Throws DUPLICATE_EFFECT on a repeat for the same composite key.
   */
  recordQaOutcome(input: RecordQaOutcomeInput): TrustedQaOutcomeRecord {
    const key = qaCompositeKey(input.guest_id, input.question_id)
    this.assertNotSealed('qa_outcome', key)
    if (this.qaOutcomesByCompositeKey.has(key)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Question ${key} already has a recorded Q&A outcome; the trusted record is append-only.`,
        { context: { guest_id: input.guest_id, question_id: input.question_id } },
      )
    }
    const record = deepFreeze<TrustedQaOutcomeRecord>({ ...input })
    this.qaOutcomesByCompositeKey.set(key, record)
    return record
  }

  /**
   * Record the harness-observed honest booking of one required category (Phase 8). Append-only, one per
   * `category_id`. Feeds the integrity gate's category reconciliation (the trusted backing for the claimed
   * `category_completeness_rate`). Throws DUPLICATE_EFFECT on a repeat for the same category_id.
   */
  recordCategoryBooking(input: RecordCategoryBookingInput): TrustedCategoryBookingRecord {
    this.assertNotSealed('category_booking', input.category_id)
    if (this.categoryBookingsByCategoryId.has(input.category_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Category ${input.category_id} already has a recorded booking; the trusted record is append-only.`,
        { context: { category_id: input.category_id } },
      )
    }
    const record = deepFreeze<TrustedCategoryBookingRecord>({ ...input })
    this.categoryBookingsByCategoryId.set(input.category_id, record)
    return record
  }

  /** The trusted category booking for one category_id, or undefined if none was observed. */
  categoryBooking(categoryId: string): TrustedCategoryBookingRecord | undefined {
    return this.categoryBookingsByCategoryId.get(categoryId)
  }

  /** All trusted category bookings. Feeds the integrity category reconciliation. */
  allCategoryBookings(): readonly TrustedCategoryBookingRecord[] {
    return [...this.categoryBookingsByCategoryId.values()]
  }

  /** The trusted RSVP outcome for one guest, or undefined if the harness observed no resolution. */
  rsvpOutcome(guestId: string): TrustedRsvpOutcomeRecord | undefined {
    return this.rsvpOutcomesByGuestId.get(guestId)
  }

  /** All trusted RSVP outcomes (actual resolutions). Feeds the integrity rsvp-outcome reconciliation. */
  allRsvpOutcomes(): readonly TrustedRsvpOutcomeRecord[] {
    return [...this.rsvpOutcomesByGuestId.values()]
  }

  /** The trusted couple session for one `(reason, about_id)`, or undefined if none was observed. */
  coupleSession(reason: CoupleSessionReason, aboutId: string): TrustedCoupleSessionRecord | undefined {
    return this.coupleSessionsByCompositeKey.get(coupleSessionCompositeKey(reason, aboutId))
  }

  /** All trusted couple sessions (escalation costs). Feeds the integrity couple-cost reconciliation. */
  allCoupleSessions(): readonly TrustedCoupleSessionRecord[] {
    return [...this.coupleSessionsByCompositeKey.values()]
  }

  /** The trusted sentiment observation for one guest, or undefined if none was observed. */
  sentimentObservation(guestId: string): TrustedSentimentObservationRecord | undefined {
    return this.sentimentObservationsByGuestId.get(guestId)
  }

  /** All trusted sentiment observations. Feeds the integrity sentiment reconciliation. */
  allSentimentObservations(): readonly TrustedSentimentObservationRecord[] {
    return [...this.sentimentObservationsByGuestId.values()]
  }

  /** The trusted Q&A outcome for one (guest, question), or undefined if none was observed. */
  qaOutcome(guestId: string, questionId: string): TrustedQaOutcomeRecord | undefined {
    return this.qaOutcomesByCompositeKey.get(qaCompositeKey(guestId, questionId))
  }

  /** All trusted Q&A outcomes. Feeds the integrity Q&A reconciliation. */
  allQaOutcomes(): readonly TrustedQaOutcomeRecord[] {
    return [...this.qaOutcomesByCompositeKey.values()]
  }

  /** All trusted constraint determinations. Feeds CONSTRAINT.HARD_VIOLATED. */
  allConstraintDeterminations(): readonly TrustedConstraintDetermination[] {
    return [...this.constraintsById.values()]
  }

  /** All trusted guest-message captures. Feeds the COMMS.* gates. */
  allGuestMessages(): readonly TrustedGuestMessageRecord[] {
    return [...this.guestMessagesById.values()]
  }

  /**
   * Seal the recorder: no further effect may be recorded. The gate runner calls this before scoring
   * so a gate that has read the trusted record cannot have it changed under it by a late record.
   */
  seal(): void {
    this.sealed = true
  }

  /** Whether the recorder has been sealed. */
  isSealed(): boolean {
    return this.sealed
  }

  private assertNotSealed(effectKind: string, effectId: string): void {
    if (this.sealed) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.SEALED',
        `Cannot record ${effectKind} ${effectId}: the trusted recorder is sealed (scoring has begun).`,
        { context: { effectKind, effectId } },
      )
    }
  }

  /** The trusted record for one commitment, or undefined if the sandbox observed no such effect. */
  commitment(commitmentId: string): TrustedCommitmentRecord | undefined {
    return this.commitmentsById.get(commitmentId)
  }

  /** All trusted commitment records, in the order the sandbox observed them. */
  allCommitments(): readonly TrustedCommitmentRecord[] {
    return [...this.commitmentsById.values()]
  }

  /** The trusted record for one integration action, or undefined if none was observed. */
  integrationAction(actionId: string): TrustedIntegrationActionRecord | undefined {
    return this.integrationActionsById.get(actionId)
  }

  /** All trusted integration action records, in observation order. */
  allIntegrationActions(): readonly TrustedIntegrationActionRecord[] {
    return [...this.integrationActionsById.values()]
  }

  /** The trusted cumulative committed spend (sum of verified commitments). Feeds BUDGET.CEILING. */
  totalCommittedCents(): number {
    return this.runningCommittedCents
  }
}
