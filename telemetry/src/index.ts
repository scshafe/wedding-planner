/**
 * @wedding-planner/telemetry — the event stream and metrics over it.
 *
 * Public barrel. The event envelope/payloads are runtime-validated; metrics are pure functions over
 * events filtered by wedding_id, with no ambient state or clock (telemetry/README.md).
 */

export const TELEMETRY_PACKAGE_NAME = '@wedding-planner/telemetry'

// Controlled vocabularies
export {
  EVENT_NAMES,
  METRIC_CODES,
  type EventName,
  type MetricCode,
} from './telemetry_constants'

// Errors
export { TelemetryError } from './telemetry_error'

// Events
export { buildEvent, type BuildEventInput, EVENT_ID_PREFIX } from './events/event_factory'
export { type TelemetryEvent, validateEventStream, forWedding } from './events/event_stream'
export {
  type CoupleSessionEndedPayload,
  type CoupleSessionReason,
  COUPLE_SESSION_REASONS,
  type GuestRsvpRequestedPayload,
  type GuestRsvpReceivedPayload,
  type GuestSentimentSampledPayload,
  type BudgetSnapshotPayload,
  type PlanFinalizedPayload,
  type RsvpStatus,
  type CategoryBookingStatus,
  readCoupleSessionEndedPayload,
  readGuestRsvpRequestedPayload,
  readGuestRsvpReceivedPayload,
  readGuestSentimentSampledPayload,
  readBudgetSnapshotPayload,
  readPlanFinalizedPayload,
} from './events/event_payload_readers'

// Metrics
export {
  MetricEngine,
  type MetricComputation,
  type MetricFunction,
} from './metrics/metric_engine'
export {
  METRIC_DEFINITIONS,
  createMetricEngine,
  coupleActiveMinutesTotal,
  autonomyRate,
  decisionReversalRate,
  rsvpResolutionRate,
  qaAccuracyRate,
  categoryCompletenessRate,
  guestSentimentScore,
  boundaryHoldRate,
  budgetVariancePct,
} from './metrics/metric_definitions'
export {
  type QaAnswerableBy,
  type QaAction,
  requiredQaAction,
} from './metrics/qa_grading'
