/**
 * @canonical id_generator -- injected identity. Ids are never read from an ambient RNG.
 *
 * An `event_id`, `candidate_id`, `ledger_id`, or `run_id` is injected from a seeded generator so a
 * run replays identically (telemetry/README.md "Determinism"). SequentialIdGenerator produces
 * stable ids that are a pure function of (seed, prefix, call order) — re-running the same sequence
 * yields the same ids, which is what lets two replays of a stream be compared byte-for-byte.
 *
 * related: clock.ts, telemetry event_factory.ts.
 */

/** A source of stable, collision-free identifiers, scoped by a string prefix. */
export interface IdGenerator {
  /** Return the next id for a prefix, e.g. next('evt') -> 'evt_<seed>_1', then 'evt_<seed>_2'. */
  next(prefix: string): string
}

/**
 * Deterministic id generator: ids are `${prefix}_${seed}_${n}` where n is a per-prefix counter.
 * Pure given the seed and the order of calls — the substrate of replayable runs.
 */
export class SequentialIdGenerator implements IdGenerator {
  private readonly countersByPrefix = new Map<string, number>()

  constructor(private readonly seed: string) {}

  next(prefix: string): string {
    const nextCount = (this.countersByPrefix.get(prefix) ?? 0) + 1
    this.countersByPrefix.set(prefix, nextCount)
    return `${prefix}_${this.seed}_${nextCount}`
  }
}
