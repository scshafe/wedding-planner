import type { EventEnvelope } from '@wedding-planner/shared'

import { forWedding } from '../events/event_stream'
import { TelemetryError } from '../telemetry_error'

/**
 * @canonical metric_engine -- computes metrics as pure functions over the event stream.
 *
 * A metric is `f(events filtered by wedding_id)` with no ambient state or clock
 * (telemetry/README.md "Metrics own no state" / "Determinism"). The engine owns no mutable state
 * beyond its immutable definition map: every call filters the input stream by wedding_id and applies
 * the pure metric function, so replaying the same stream yields the identical result.
 */

/**
 * The result of computing one metric. `value` is null when the metric is undefined for this stream
 * (e.g. a rate whose denominator is zero) — reported honestly, never coerced to a fallback number.
 * `support` carries the numerator/denominator/counts behind the value for auditability.
 */
export interface MetricComputation {
  readonly metric_code: string
  readonly value: number | null
  readonly support: Readonly<Record<string, number>>
}

/** A metric: a pure function from a wedding-scoped event stream to a computation. */
export type MetricFunction = (eventsForWedding: readonly EventEnvelope[]) => MetricComputation

export class MetricEngine {
  constructor(private readonly definitions: ReadonlyMap<string, MetricFunction>) {}

  /** The metric codes this engine can compute. */
  metricCodes(): readonly string[] {
    return [...this.definitions.keys()]
  }

  /** Whether a metric code is registered. */
  has(metricCode: string): boolean {
    return this.definitions.has(metricCode)
  }

  /** Compute one metric for a wedding. Throws TELEMETRY.METRIC_NOT_REGISTERED for an unknown code. */
  compute(
    metricCode: string,
    allEvents: readonly EventEnvelope[],
    weddingId: string,
  ): MetricComputation {
    return this.applyDefinition(metricCode, forWedding(allEvents, weddingId))
  }

  /** Compute several metrics for a wedding, filtering the stream once. Order is preserved. */
  computeMany(
    metricCodes: readonly string[],
    allEvents: readonly EventEnvelope[],
    weddingId: string,
  ): MetricComputation[] {
    const scoped = forWedding(allEvents, weddingId)
    return metricCodes.map((metricCode) => this.applyDefinition(metricCode, scoped))
  }

  private applyDefinition(
    metricCode: string,
    eventsForWedding: readonly EventEnvelope[],
  ): MetricComputation {
    const definition = this.definitions.get(metricCode)
    if (definition === undefined) {
      throw new TelemetryError(
        'TELEMETRY.METRIC_NOT_REGISTERED',
        `No metric function registered for code '${metricCode}'.`,
        { context: { metricCode, registered: [...this.definitions.keys()] } },
      )
    }
    return definition(eventsForWedding)
  }
}
