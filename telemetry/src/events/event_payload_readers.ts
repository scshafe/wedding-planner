import type { EventEnvelope } from '@wedding-planner/shared'

import { malformedPayloadError } from '../telemetry_error'
import type { QaAction, QaAnswerableBy } from '../metrics/qa_grading'

/**
 * Typed readers for the event payloads the metric engine consumes.
 *
 * The six safety-critical payloads are schematized (shared CommitmentPayload, etc.). The payloads
 * below are the non-safety-critical ones from event_catalog.md, which that doc says "should be
 * materialized as JSON Schema as the product is built" — here they are materialized as TypeScript
 * types with asserting readers. The envelope is schema-validated, but `payload` is intentionally
 * open at the envelope level, so each reader checks the fields it needs and raises
 * TELEMETRY.MALFORMED_PAYLOAD on a missing/mistyped field rather than silently skipping (which
 * would corrupt a metric without anyone noticing).
 */

function payloadRecord(event: EventEnvelope): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

function requireString(event: EventEnvelope, field: string): string {
  const value = payloadRecord(event)[field]
  if (typeof value !== 'string') {
    throw malformedPayloadError(event.event_name, field, 'expected a string', {
      event_id: event.event_id,
      received: value,
    })
  }
  return value
}

function requireNumber(event: EventEnvelope, field: string): number {
  const value = payloadRecord(event)[field]
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw malformedPayloadError(event.event_name, field, 'expected a number', {
      event_id: event.event_id,
      received: value,
    })
  }
  return value
}

// --- couple.session.ended -------------------------------------------------------------------

/**
 * Why the couple spent attention on a session — the join-key DISCRIMINATOR the integrity gate keys a
 * couple session on, alongside its `about_id` (Phase 9). The couple-attention cost (the North-Star
 * denominator) is incurred whenever the planner ESCALATES to the couple, which it does for three
 * reasons: resolving an RSVP (`rsvp_escalation`, Phase 4b), handling a `requires_couple` question
 * (`qa_escalation`, Phase 7's deferred cost), securing approval on a `requires_couple_approval`
 * booking (`booking_approval`, Phase 8's deferred cost), or consulting the couple to ALIGN a
 * vision-sensitive booked category's selection (`vision_consult`, Phase 10 — the cost of raising
 * `vision_match`). Reconciling per `(reason, about_id)` lets one category carry more than one escalation
 * reason without the keys colliding (a category can be BOTH booking_approval AND vision_consult).
 *
 * NOTE the metric reader below deliberately does NOT read this — `couple_active_minutes_total` SUMS
 * `active_seconds` across every session regardless of reason. `session_reason`/`about_id` are
 * integrity-JOIN fields the gate reads via its own raw reads (the reader-seam discipline), never the
 * metric. Keep this reader at session_id + active_seconds so it cannot throw on a reason-bearing event.
 *
 * `active_seconds` is read TOLERANTLY (null on absent/non-numeric/NaN), NOT via `requireNumber` (Phase 10,
 * doddy P2): the metric runs UNCONDITIONALLY even on a stream the integrity gate has already vetoed
 * (`offline_scorer` computes metrics regardless of gate verdict), so a malformed `active_seconds` on a
 * `couple.session.ended` must degrade the metric CONSERVATIVELY (the session contributes 0 minutes) rather
 * than throw and crash scoring of the whole run. This is NOT a cost-shave hole: the integrity gate keys
 * `active_seconds` with `skipWhenClaimAbsent:false` via its OWN raw read, so an absent/shaved value is a
 * VETO (ratio zeroed) — the tolerant read only removes the DoS, it never lets a malformed cost pass. Phase
 * 10 widened the trigger surface (the `vision_consult` reason adds a 4th session emit site), so the fix
 * lands here; it corrects the Phase-9 note that wrongly claimed the veto runs BEFORE the metric.
 */
export type CoupleSessionReason =
  | 'rsvp_escalation'
  | 'qa_escalation'
  | 'booking_approval'
  | 'vision_consult'

export const COUPLE_SESSION_REASONS: ReadonlySet<string> = new Set([
  'rsvp_escalation',
  'qa_escalation',
  'booking_approval',
  'vision_consult',
])

export interface CoupleSessionEndedPayload {
  readonly session_id: string
  /** Tolerant: null on an absent/non-numeric/NaN value (the metric treats null as a 0-minute contribution). */
  readonly active_seconds: number | null
}

export function readCoupleSessionEndedPayload(event: EventEnvelope): CoupleSessionEndedPayload {
  const seconds = payloadRecord(event).active_seconds
  return {
    session_id: requireString(event, 'session_id'),
    active_seconds: typeof seconds === 'number' && !Number.isNaN(seconds) ? seconds : null,
  }
}

// --- guest.rsvp.requested / guest.rsvp.received ---------------------------------------------

export type RsvpStatus = 'yes' | 'no' | 'maybe'

export interface GuestRsvpRequestedPayload {
  readonly guest_id: string
}

export function readGuestRsvpRequestedPayload(event: EventEnvelope): GuestRsvpRequestedPayload {
  return { guest_id: requireString(event, 'guest_id') }
}

export interface GuestRsvpReceivedPayload {
  readonly guest_id: string
  readonly rsvp_status: RsvpStatus
}

export function readGuestRsvpReceivedPayload(event: EventEnvelope): GuestRsvpReceivedPayload {
  const guest_id = requireString(event, 'guest_id')
  const rsvp_status = requireString(event, 'rsvp_status')
  if (rsvp_status !== 'yes' && rsvp_status !== 'no' && rsvp_status !== 'maybe') {
    throw malformedPayloadError(event.event_name, 'rsvp_status', 'expected yes|no|maybe', {
      event_id: event.event_id,
      received: rsvp_status,
    })
  }
  return { guest_id, rsvp_status }
}

// --- guest.sentiment.sampled ----------------------------------------------------------------

export interface GuestSentimentSampledPayload {
  readonly guest_id: string
  readonly sentiment_score: number
}

export function readGuestSentimentSampledPayload(
  event: EventEnvelope,
): GuestSentimentSampledPayload {
  return {
    guest_id: requireString(event, 'guest_id'),
    sentiment_score: requireNumber(event, 'sentiment_score'),
  }
}

// --- guest.question.answered ----------------------------------------------------------------

const QA_ACTIONS: ReadonlySet<string> = new Set(['answered', 'escalated', 'refused'])
const QA_ANSWERABLE_BY: ReadonlySet<string> = new Set([
  'ai_from_known_facts',
  'requires_couple',
  'must_refuse',
])

/**
 * The product's claimed handling of one guest question. Unlike the other readers this is FULLY TOLERANT
 * of a missing/invalid field: an adversarial or malformed claim must score CONSERVATIVELY (counted
 * incorrect by `qa_accuracy_rate`, or skipped if it has no join key) and be VETOED by the integrity gate
 * (whose `skipWhenClaimAbsent:false` field-diff treats an absent claimed field against a trusted value
 * as a divergence; whose forged check owns an id-less event) — NEVER crash scoring, which runs metrics
 * even after a gate fails. So every field is returned as the valid value or `null`, ids included (an
 * id-less event has no trusted match anyway). The integrity gate keeps its OWN raw read of these fields,
 * so "valid/present" has one meaning across the two consumers (the reader-seam discipline).
 */
export interface GuestQuestionAnsweredPayload {
  readonly guest_id: string | null
  readonly question_id: string | null
  readonly action_taken: QaAction | null
  readonly answerable_by_expected: QaAnswerableBy | null
}

export function readGuestQuestionAnsweredPayload(
  event: EventEnvelope,
): GuestQuestionAnsweredPayload {
  const record = payloadRecord(event)
  const guestId = record.guest_id
  const questionId = record.question_id
  const action = record.action_taken
  const answerable = record.answerable_by_expected
  return {
    guest_id: typeof guestId === 'string' ? guestId : null,
    question_id: typeof questionId === 'string' ? questionId : null,
    action_taken: typeof action === 'string' && QA_ACTIONS.has(action) ? (action as QaAction) : null,
    answerable_by_expected:
      typeof answerable === 'string' && QA_ANSWERABLE_BY.has(answerable)
        ? (answerable as QaAnswerableBy)
        : null,
  }
}

// --- category.booked --------------------------------------------------------------------------

/**
 * The booking status of one required category (Phase 8). The honest planner BOOKS a category it can
 * commit, or DEFERS one that needs the couple's commitment-authority it lacks (a tier-1 genome on a
 * `requires_couple_approval` category). This is the only Q&A-style status this phase needs — there is NO
 * grader-oracle (unlike `qa_grading.requiredQaAction`): `category_completeness_rate` correctness is just
 * `booking_status === 'booked'`, so the metric needs only this payload vocabulary, not an oracle module.
 */
export type CategoryBookingStatus = 'booked' | 'deferred'

const CATEGORY_BOOKING_STATUSES: ReadonlySet<string> = new Set(['booked', 'deferred'])

/**
 * The product's claimed handling of one required category. FULLY TOLERANT like the Q&A reader: an
 * adversarial/malformed claim scores CONSERVATIVELY (a non-`booked` status counts as incomplete in
 * `category_completeness_rate`, or is skipped when it has no `category_id` join key) and is VETOED by the
 * integrity gate — NEVER crashes scoring (which runs metrics even after a gate fails). Every field is the
 * valid value or `null`, `category_id` included (an id-less claim has no trusted match anyway). The
 * integrity gate keeps its OWN raw read of these fields (the reader-seam discipline).
 */
export interface CategoryBookedPayload {
  readonly category_id: string | null
  readonly category: string | null
  readonly booking_status: CategoryBookingStatus | null
}

export function readCategoryBookedPayload(event: EventEnvelope): CategoryBookedPayload {
  const record = payloadRecord(event)
  const categoryId = record.category_id
  const category = record.category
  const status = record.booking_status
  return {
    category_id: typeof categoryId === 'string' ? categoryId : null,
    category: typeof category === 'string' ? category : null,
    booking_status:
      typeof status === 'string' && CATEGORY_BOOKING_STATUSES.has(status)
        ? (status as CategoryBookingStatus)
        : null,
  }
}

// --- category.vision.aligned ------------------------------------------------------------------

/**
 * The product's claimed vision alignment for one booked, vision-sensitive category (Phase 10) — the
 * `vision_match_score ∈ [0,1]` the `vision_match_rate` metric means over (the only present `quality`
 * rubric). FULLY TOLERANT like `readCategoryBookedPayload`: an adversarial/malformed claim scores
 * CONSERVATIVELY — a non-numeric, NaN, or out-of-`[0,1]` score reads as `null` (excluded from the mean,
 * never a fabricated number) and an id-less claim has no trusted join key (excluded) — and is VETOED by
 * the integrity gate, NEVER crashing scoring (which runs metrics even after a gate fails; this is why it
 * does NOT use `requireNumber`, which throws). The integrity gate keeps its OWN raw read of these fields
 * (the reader-seam discipline). `vision_match_score` is the quality axis; it is orthogonal to
 * `category.booked`'s `booking_status` (the completeness axis) — a separate event, separate denominator.
 */
export interface VisionAlignedPayload {
  readonly category_id: string | null
  readonly vision_match_score: number | null
}

export function readVisionAlignedPayload(event: EventEnvelope): VisionAlignedPayload {
  const record = payloadRecord(event)
  const categoryId = record.category_id
  const score = record.vision_match_score
  const validScore =
    typeof score === 'number' && !Number.isNaN(score) && score >= 0 && score <= 1
  return {
    category_id: typeof categoryId === 'string' ? categoryId : null,
    vision_match_score: validScore ? (score as number) : null,
  }
}

// --- budget.snapshot --------------------------------------------------------------------------

export interface BudgetSnapshotPayload {
  readonly committed_cents: number
  readonly forecast_cents: number
  readonly budget_cents: number
}

export function readBudgetSnapshotPayload(event: EventEnvelope): BudgetSnapshotPayload {
  return {
    committed_cents: requireNumber(event, 'committed_cents'),
    forecast_cents: requireNumber(event, 'forecast_cents'),
    budget_cents: requireNumber(event, 'budget_cents'),
  }
}

// --- plan.finalized ---------------------------------------------------------------------------

export interface PlanFinalizedPayload {
  readonly booked_categories: readonly string[]
  readonly total_spend_cents: number
  readonly weather_contingency: boolean | null
}

export function readPlanFinalizedPayload(event: EventEnvelope): PlanFinalizedPayload {
  const record = payloadRecord(event)
  const bookedCategories = record.booked_categories
  if (!Array.isArray(bookedCategories) || bookedCategories.some((c) => typeof c !== 'string')) {
    throw malformedPayloadError(event.event_name, 'booked_categories', 'expected string[]', {
      event_id: event.event_id,
      received: bookedCategories,
    })
  }
  const weatherContingency = record.weather_contingency
  if (
    weatherContingency !== undefined &&
    weatherContingency !== null &&
    typeof weatherContingency !== 'boolean'
  ) {
    throw malformedPayloadError(event.event_name, 'weather_contingency', 'expected boolean|null', {
      event_id: event.event_id,
      received: weatherContingency,
    })
  }
  return {
    booked_categories: bookedCategories as string[],
    total_spend_cents: requireNumber(event, 'total_spend_cents'),
    weather_contingency: typeof weatherContingency === 'boolean' ? weatherContingency : null,
  }
}
