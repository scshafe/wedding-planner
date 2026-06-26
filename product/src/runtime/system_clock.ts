import type { Clock } from '@wedding-planner/shared'

/**
 * @canonical system_clock -- the EDGE-ONLY wall clock. The single place ambient time enters the system.
 *
 * The determinism rail (shared/src/determinism/clock.ts) is absolute for the CORE and all tests: nothing
 * there reads an ambient clock — the only `Clock` impl in `@wedding-planner/shared` is `ManualClock`, which
 * advances exactly when told, so eval/grader/loop runs replay byte-for-byte. This `SystemClock` is the ONE
 * deliberate exception, and it lives HERE — under `product/src/runtime/`, NOT in `shared`'s barrel — for a
 * structural reason: the eval/loop replay core imports `@wedding-planner/shared` and never
 * `@wedding-planner/product`, so a wall clock placed here is physically UNREACHABLE from the code whose
 * determinism it would threaten. It is also exported from NEITHER barrel: the deployable entrypoint
 * (`app/server.ts`) is the only importer, by relative path, so no test or core file can grab it by
 * autocomplete.
 *
 * The functional-core / imperative-shell discipline: the entrypoint is the impure shell where the wall
 * clock, identity, env config, and the socket enter; everything below it stays injected, deterministic, and
 * testable. `composeProductSurface` takes a `Clock` as config, so it unit-tests with `ManualClock` and only
 * `app/server.ts` ever constructs a `SystemClock`.
 *
 * related: random_id_generator.ts (its identity peer), compose.ts (the consumer), shared/.../clock.ts.
 */
export class SystemClock implements Clock {
  /** The current wall-clock instant as an ISO 8601 UTC string. The one ambient-time read in the system. */
  now(): string {
    return new Date().toISOString()
  }
}
