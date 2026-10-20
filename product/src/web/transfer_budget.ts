/**
 * @canonical transfer_budget -- the process-wide budget of bytes in flight (issue #48's security reviews, ADR 0056).
 *
 * A document is up to 5 MiB, so a few clients that ask for many and never read the answers (pipelined requests, or
 * many connections), or that send bodies and stall, could make the process hold hundreds of MB and be killed by its
 * memory limit. So the edge holds EVERY request body (as it arrives) and EVERY response against one budget until the
 * exchange is done — written, closed, or its connection closed — and answers 503 instead of taking what does not fit:
 *   - a body chunk that does not fit ends its request (503, connection closed);
 *   - a read (GET/HEAD) whose response does not fit gets a 503 instead; a write is checked for room BEFORE it runs, and
 *     once applied its response is always sent (the budget may be passed by that one response), so a 503 never follows
 *     a change that happened;
 *   - a response can name a key (a download names its session): one key holds at most `per_key_bytes`, so one session
 *     cannot hold the budget on its own;
 *   - a response of at least {@link LARGE_TRANSFER_BYTES} must be written within a deadline.
 * Large upload bodies take one of a few places, one per workspace, each within a deadline.
 *
 * In-process by design: one container, and the numbers are about this process's memory.
 *
 * related: web_server.ts (holds and releases), product_web_ui.ts (the download's key and check, the upload's grant).
 */

const MIB = 1024 * 1024

/** A response at least this big must be written within `response_deadline_ms`. */
export const LARGE_TRANSFER_BYTES = 256 * 1024

export const TRANSFER_LIMITS = Object.freeze({
  /** Request bodies and responses in flight at once, in bytes. */
  in_flight_bytes: 48 * MIB,
  /** What one key (a session's downloads) may hold at once. */
  per_key_bytes: 12 * MIB,
  /** How long a large response may take to be written before its connection is dropped. */
  response_deadline_ms: 120_000,
  /** Large upload bodies being received at once (one per workspace). */
  large_uploads: 3,
  /** How long a large upload body may take to arrive. */
  upload_deadline_ms: 60_000,
})

export type TransferLimits = { readonly [K in keyof typeof TRANSFER_LIMITS]: number }

export class TransferBudget {
  #bytes = 0
  readonly #byKey = new Map<string, number>()
  readonly #uploads = new Set<string>()

  constructor(readonly limits: TransferLimits = TRANSFER_LIMITS) {}

  /** Whether `bytes` more would fit now, overall and for `key` (checked before building a response). */
  canSend(bytes: number, key?: string): boolean {
    if (this.#bytes + bytes > this.limits.in_flight_bytes) return false
    return key === undefined || (this.#byKey.get(key) ?? 0) + bytes <= this.limits.per_key_bytes
  }

  /**
   * Hold `bytes` until the returned release runs (once); `undefined` when they do not fit. `force` holds them anyway
   * (the response of a write already applied).
   */
  hold(bytes: number, options: { readonly key?: string; readonly force?: boolean } = {}): (() => void) | undefined {
    const { key, force } = options
    if (force !== true && !this.canSend(bytes, key)) return undefined
    this.#bytes += bytes
    if (key !== undefined) this.#byKey.set(key, (this.#byKey.get(key) ?? 0) + bytes)
    return once(() => {
      this.#bytes -= bytes
      if (key === undefined) return
      const left = (this.#byKey.get(key) ?? bytes) - bytes
      if (left <= 0) this.#byKey.delete(key)
      else this.#byKey.set(key, left)
    })
  }

  /**
   * Hold a place for one large upload body of `owner` (a workspace) until the returned release runs (once);
   * `undefined` when all places are taken or the owner already holds one, so no workspace takes them all.
   */
  holdUpload(owner: string): (() => void) | undefined {
    if (this.#uploads.size >= this.limits.large_uploads || this.#uploads.has(owner)) return undefined
    this.#uploads.add(owner)
    return once(() => {
      this.#uploads.delete(owner)
    })
  }
}

function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}
