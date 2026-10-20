/**
 * @canonical transfer_budget -- the process-wide budget of large bodies in flight (issue #48's security review, ADR 0056).
 *
 * A document is up to 5 MiB, so a few clients that ask for many and never read the answers (pipelined requests, or
 * many connections) could make the process hold hundreds of MB and be killed by its memory limit. The edge holds
 * every LARGE response (at least {@link LARGE_TRANSFER_BYTES}) against one budget until it is written or its connection
 * closes, and answers 503 instead of holding one that does not fit; the download page checks the budget before it
 * reads a document at all. Large upload bodies are limited the same way: a few at once, each within a deadline.
 *
 * In-process by design: one container, and the numbers are about this process's memory.
 *
 * related: web_server.ts (holds and releases), product_web_ui.ts (the download's check, the upload's grant).
 */

const MIB = 1024 * 1024

/** A response at least this big is held against the budget. */
export const LARGE_TRANSFER_BYTES = 256 * 1024

export const TRANSFER_LIMITS = Object.freeze({
  /** Large responses in flight at once, in bytes. */
  response_bytes: 48 * MIB,
  /** Large upload bodies being received at once. */
  large_uploads: 3,
  /** How long a large upload body may take to arrive. */
  upload_deadline_ms: 60_000,
})

export type TransferLimits = { readonly [K in keyof typeof TRANSFER_LIMITS]: number }

export class TransferBudget {
  #responseBytes = 0
  #uploads = 0

  constructor(readonly limits: TransferLimits = TRANSFER_LIMITS) {}

  /** Whether a response of `bytes` would fit now (checked before building one). */
  canSend(bytes: number): boolean {
    return this.#responseBytes + bytes <= this.limits.response_bytes
  }

  /** Hold `bytes` of response until the returned release runs (once); `undefined` when it does not fit. */
  holdResponse(bytes: number): (() => void) | undefined {
    if (!this.canSend(bytes)) return undefined
    this.#responseBytes += bytes
    return once(() => {
      this.#responseBytes -= bytes
    })
  }

  /** Hold a place for one large upload body until the returned release runs (once); `undefined` when all are taken. */
  holdUpload(): (() => void) | undefined {
    if (this.#uploads >= this.limits.large_uploads) return undefined
    this.#uploads += 1
    return once(() => {
      this.#uploads -= 1
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
