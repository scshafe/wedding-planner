/**
 * @canonical clock -- injected time. Nothing in this system reads an ambient clock.
 *
 * Determinism is the precondition for attributing a metric delta to a product change rather than
 * to noise (telemetry/README.md "Determinism"). Every timestamp the system writes — an event's
 * `occurred_at`, a ledger transition's `at`, a grade report's `started_at` — comes from an injected
 * Clock, never from `Date.now()` or `new Date()`. In Phase 1 (offline) the only implementation is
 * ManualClock, which advances exactly when told, so a run replays identically.
 *
 * related: id_generator.ts, telemetry event_factory.ts.
 */

/** A source of ISO 8601 UTC timestamps. Injected so time never enters the system ambiently. */
export interface Clock {
  /** The current time as an ISO 8601 UTC string (e.g. '2027-01-02T15:00:00.000Z'). */
  now(): string
}

/**
 * A deterministic clock that starts at an explicit instant and only moves when `advance`/`set` is
 * called. Constructing from an explicit millisecond value is pure — no ambient time is ever read.
 */
export class ManualClock implements Clock {
  private currentMs: number

  /** @param startIso an ISO 8601 timestamp the clock starts at. */
  constructor(startIso: string) {
    this.currentMs = ManualClock.parseOrThrow(startIso)
  }

  now(): string {
    // new Date(ms) with an explicit argument is deterministic (unlike argless new Date()).
    return new Date(this.currentMs).toISOString()
  }

  /** Advance the clock by a number of milliseconds. */
  advance(milliseconds: number): void {
    this.currentMs += milliseconds
  }

  /** Set the clock to an explicit ISO 8601 instant. */
  set(iso: string): void {
    this.currentMs = ManualClock.parseOrThrow(iso)
  }

  private static parseOrThrow(iso: string): number {
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) {
      throw new Error(`ManualClock: not a valid ISO 8601 timestamp: '${iso}'`)
    }
    return ms
  }
}
