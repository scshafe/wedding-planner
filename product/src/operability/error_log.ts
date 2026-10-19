import { type Clock, type IdGenerator, WeddingPlannerError } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import { logMethod, routePattern } from './request_log'

/**
 * @canonical error_log -- the server errors the operator lists at /admin/errors (issue #13, ADR 0044).
 *
 * Every request that ends in a 500 records one entry: the `DOMAIN.FAILURE_MODE` code (a WeddingPlannerError's own
 * code, or `UNHANDLED.<ErrorName>` for anything else), the error's class name, the top stack frames (code locations
 * only), the method, the route PATTERN and tenant slug (request_log.ts), and the time. NEVER the error message, the
 * request, or any value: a message can embed data (a JSON parse error quotes its input; a store error can quote a
 * stored record). V8 puts the message — every line of it — at the head of `error.stack`, so the frames are taken
 * only AFTER those header lines, and only lines shaped like a code location (`at fn (/path:line:col)`) are kept:
 * a message line that happens to start with "at " can never pass for a frame.
 *
 * A `PERSISTENCE.STORAGE_FAILED` is not recorded durably: the store is what failed, and writing to it again would
 * only block (busy timeouts) or fail. Those requests still show as 500s on their route in the request log.
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

/** An identifier-shaped error name (anything else is reported as `Unknown`). */
const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/

/** A stack line that is a code location: `at [fn ](path:line:col)` with a file, file:// or node: path. */
const FRAME = /^at (?:([\w$.#<>[\] ]{1,120}) \()?((?:file:\/\/|node:|\/)[^\s()]{1,300}:\d+:\d+)\)?$/

/** The error's class name, if identifier-shaped. */
export function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  return SAFE_NAME.test(name) ? name : 'Unknown'
}

/** The code an error is filed under. */
export function errorCode(error: unknown): string {
  if (error instanceof WeddingPlannerError) return error.code
  return `UNHANDLED.${errorName(error)}`
}

/** The top stack frames, as code locations only — never a line of the message (see the module docstring). */
export function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || error.stack === undefined) return []
  // V8: the stack starts with `Name: message` (or just `Name`), every line of a multi-line message included.
  const header = error.message.length > 0 ? `${error.name}: ${error.message}` : error.name
  const lines = error.stack.split('\n')
  const body = lines.slice(lines.slice(0, header.split('\n').length).join('\n') === header ? header.split('\n').length : 0)
  const frames: string[] = []
  for (const line of body) {
    const match = FRAME.exec(line.trim())
    if (match === null) continue
    frames.push(match[1] === undefined ? `at ${match[2]}` : `at ${match[1]} (${match[2]})`)
    if (frames.length === MAX_FRAMES) break
  }
  return frames
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

  /** Record a 500's error. Never throws. A storage failure is not recorded (see the module docstring). */
  record(error: unknown, request: { readonly method: string; readonly path: string }): void {
    if (error instanceof WeddingPlannerError && error.code === 'PERSISTENCE.STORAGE_FAILED') return
    try {
      const { route, tenant } = routePattern(request.path)
      const entry: ServerError = {
        error_id: this.ids.next('error'),
        occurred_at: this.clock.now(),
        code: errorCode(error),
        name: errorName(error),
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
