import { randomUUID } from 'node:crypto'

import type { IdGenerator } from '@wedding-planner/shared'

/**
 * @canonical random_id_generator -- the EDGE-ONLY non-deterministic id source. Peer of SystemClock.
 *
 * The determinism rail makes `SequentialIdGenerator` the only `IdGenerator` in `@wedding-planner/shared`:
 * ids are a pure function of (seed, prefix, call order) so a run replays byte-for-byte. A long-lived
 * deployed process, however, must mint ids that do not collide across requests and do not repeat a fixed
 * sequence — so the entrypoint injects THIS generator instead. It backs each id with `crypto.randomUUID()`
 * (a v4 UUID, 122 bits of entropy), keeping the `${prefix}_${...}` shape every store already produces.
 *
 * Like `SystemClock` it lives under `product/src/runtime/` (unreachable from the eval/loop replay core,
 * which imports only `@wedding-planner/shared`) and is exported from NEITHER barrel — `app/server.ts` is the
 * sole importer, by relative path. `composeProductSurface` takes an `IdGenerator` as config, so it tests
 * with `SequentialIdGenerator` and only the deployed entrypoint constructs a `RandomIdGenerator`.
 *
 * related: system_clock.ts (its time peer), compose.ts (the consumer), shared/.../id_generator.ts.
 */
export class RandomIdGenerator implements IdGenerator {
  /** A collision-free id for the prefix: `${prefix}_${uuidv4}`. Non-deterministic by design (edge-only). */
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`
  }
}
