import { type Clock, type EventEnvelope, getSchemaRegistry, type IdGenerator } from '@wedding-planner/shared'

/**
 * @canonical event_factory -- the one way to construct a telemetry event.
 *
 * Builds a schema-validated EventEnvelope, injecting `event_id` from the IdGenerator and
 * `occurred_at` from the Clock unless the caller supplies them explicitly. Nothing here reads an
 * ambient clock or RNG, so a run built through this factory replays identically (telemetry/README.md
 * "Determinism"). The constructed event is validated against the event_envelope contract before it
 * is returned — a malformed event never enters a stream.
 */

/** Fields needed to build an event; event_id and occurred_at are injected if omitted. */
export type BuildEventInput = Omit<EventEnvelope, 'event_id' | 'occurred_at'> & {
  readonly event_id?: string
  readonly occurred_at?: string
}

/** The id-generator prefix used for telemetry event ids. */
export const EVENT_ID_PREFIX = 'evt'

/**
 * Build a validated telemetry event. `event_id` comes from `ids.next('evt')` and `occurred_at` from
 * `clock.now()` unless explicitly provided. Throws ContractValidationFailedError if the result does
 * not conform to the event_envelope contract.
 */
export function buildEvent(clock: Clock, ids: IdGenerator, input: BuildEventInput): EventEnvelope {
  const candidate: EventEnvelope = {
    ...input,
    event_id: input.event_id ?? ids.next(EVENT_ID_PREFIX),
    occurred_at: input.occurred_at ?? clock.now(),
  }
  return getSchemaRegistry().assertValid<EventEnvelope>('event_envelope', candidate)
}
