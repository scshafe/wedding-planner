import { type EventEnvelope, getSchemaRegistry } from '@wedding-planner/shared'

import { TelemetryError } from '../telemetry_error'

/**
 * A telemetry event and operations over a stream of them.
 *
 * A metric is `f(events filtered by wedding_id)` (telemetry/README.md). `forWedding` is that filter;
 * `validateEventStream` is the gate that an externally-sourced stream conforms to the contract
 * before any metric or gate reads it.
 */

/** The canonical event type — the validated envelope. */
export type TelemetryEvent = EventEnvelope

/**
 * Validate an array of unknown values as telemetry events. Throws TELEMETRY.INVALID_EVENT_STREAM
 * (wrapping the contract error) identifying the offending index — a stream is all-or-nothing so a
 * downstream metric never silently reads a malformed event.
 */
export function validateEventStream(events: readonly unknown[]): EventEnvelope[] {
  const registry = getSchemaRegistry()
  return events.map((event, index) => {
    const result = registry.validate<EventEnvelope>('event_envelope', event)
    if (!result.valid) {
      throw new TelemetryError(
        'TELEMETRY.INVALID_EVENT_STREAM',
        `Event at index ${index} does not conform to the event_envelope contract.`,
        { context: { index, validationErrors: result.errors } },
      )
    }
    return result.data
  })
}

/** Return only the events for one wedding — the aggregate root every metric groups by. */
export function forWedding(
  events: readonly EventEnvelope[],
  weddingId: string,
): EventEnvelope[] {
  return events.filter((event) => event.wedding_id === weddingId)
}
