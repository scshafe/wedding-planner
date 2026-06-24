import { WeddingPlannerError } from '@wedding-planner/shared'

/**
 * Errors raised by the telemetry domain. Codes are TELEMETRY.<FAILURE_MODE>.
 *
 * related: shared WeddingPlannerError (base type).
 */
export class TelemetryError extends WeddingPlannerError {}

/** A consumed event payload was missing a required field or had the wrong type. */
export function malformedPayloadError(
  eventName: string,
  field: string,
  detail: string,
  context: Record<string, unknown>,
): TelemetryError {
  return new TelemetryError(
    'TELEMETRY.MALFORMED_PAYLOAD',
    `Event '${eventName}' payload field '${field}' is malformed: ${detail}`,
    { context: { eventName, field, ...context } },
  )
}
