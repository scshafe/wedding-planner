import type { EventEnvelope } from '@wedding-planner/shared'

import { malformedPayloadError } from '../telemetry_error'

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

export interface CoupleSessionEndedPayload {
  readonly session_id: string
  readonly active_seconds: number
}

export function readCoupleSessionEndedPayload(event: EventEnvelope): CoupleSessionEndedPayload {
  return {
    session_id: requireString(event, 'session_id'),
    active_seconds: requireNumber(event, 'active_seconds'),
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
