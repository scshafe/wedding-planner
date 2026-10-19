import { type Clock, type IdGenerator, WeddingPlannerError } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import { logMethod, routePattern } from './request_log'

/**
 * @canonical error_log -- the server errors the operator lists at /admin/errors (issue #13, ADR 0044).
 *
 * Every request that ends in a 500 records one entry: the `DOMAIN.FAILURE_MODE` code (a WeddingPlannerError's own
 * code, or `UNHANDLED.<ErrorName>` for anything else), the error's class name, the top stack frames (file:line
 * locations only), the method, the route PATTERN and tenant slug (request_log.ts), and the time. NEVER the error
 * message, the request, or any value: a message can embed data (a JSON parse error quotes its input; a store error
 * can quote a stored record), so the entry holds only what locates the fault.
 *
 * Bounded (the newest {@link ERROR_RETENTION}) in the global partition, like the outbox. Recording runs OUTSIDE the
 * failed request's transaction (in the catch, after the rollback), and never throws: if the store itself is what
 * failed, the entry is lost rather than turning a 500 into a crash.
 *
 * related: product_api.ts / product_web_ui.ts (record on a 500), request_log.ts.
 */

/** How many errors are kept. */
export const ERROR_RETENTION = 200

/** The most stack frames kept per error. */
const MAX_FRAMES = 5

export interface ServerError {
  readonly error_id: string
  readonly occurred_at: string
  readonly code: string
  readonly name: string
  readonly frames: readonly string[]
  readonly method: string
  readonly route: string
  readonly tenant?: string
}

/** The code an error is filed under. */
export function errorCode(error: unknown): string {
  if (error instanceof WeddingPlannerError) return error.code
  const name = error instanceof Error ? error.name : typeof error
  return `UNHANDLED.${/^[A-Za-z0-9_]+$/.test(name) ? name : 'Unknown'}`
}

/** The top stack frames, as locations only (`at fn (file:line:col)`), each bounded. */
export function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || error.stack === undefined) return []
  return error.stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, MAX_FRAMES)
    .map((line) => line.slice(0, 200))
}

export class ErrorLog {
  readonly #store: RecordStore

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
    private readonly retention: number = ERROR_RETENTION,
  ) {
    this.#store = store
  }

  /** Record a 500's error. Never throws. */
  record(error: unknown, request: { readonly method: string; readonly path: string }): void {
    try {
      const { route, tenant } = routePattern(request.path)
      const entry: ServerError = {
        error_id: this.ids.next('error'),
        occurred_at: this.clock.now(),
        code: errorCode(error),
        name: error instanceof Error ? error.name : typeof error,
        frames: stackFrames(error),
        method: logMethod(request.method),
        route,
        ...(tenant === undefined ? {} : { tenant }),
      }
      this.#store.put(COLLECTIONS.serverError, GLOBAL_PARTITION, entry.error_id, entry)
      const all = this.#store.list(COLLECTIONS.serverError, GLOBAL_PARTITION)
      for (const old of all.slice(0, Math.max(0, all.length - this.retention))) {
        this.#store.delete(COLLECTIONS.serverError, GLOBAL_PARTITION, old.error_id)
      }
    } catch {
      // The store may be what failed; losing the entry beats crashing the request.
    }
  }

  /** The most recent errors, newest first, at most `limit`. */
  recent(limit: number): readonly ServerError[] {
    return this.#store.list(COLLECTIONS.serverError, GLOBAL_PARTITION).reverse().slice(0, Math.max(0, limit))
  }
}
