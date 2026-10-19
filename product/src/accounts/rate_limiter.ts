import { type Clock, sha256Hex } from '@wedding-planner/shared'

/**
 * @canonical rate_limiter -- in-process, fixed-window attempt counting (issue #10, ADR 0041).
 *
 * Callers count attempts per key (e.g. tenant + submitted email) in fixed windows of the injected clock. Keys are
 * whatever the caller submits — the limiter never looks an account up — so a limited response says nothing about
 * whether an account exists.
 *
 * Bounded memory, by construction: every key is stored as its sha256 (a submitted email of any size costs 64
 * characters), each entry remembers its own window, and the table holds at most {@link MAX_KEYS} entries — past that
 * the oldest entry (Map insertion order) is evicted. A flood of distinct keys therefore costs a fixed amount of
 * memory; the price is that a flood can push an older key's count out early (it then starts fresh).
 *
 * `attempt` counts and answers; `blocked` answers without counting and `hit` counts without answering — the pair a
 * failures-only limit needs (check before the work, count only a failure).
 *
 * In-process by design (the issue allows it): one container, and a restart resetting the counters is acceptable.
 *
 * related: account_service.ts (the rules it applies), feedback_service.ts.
 */

/** At most `limit` attempts per `windowSeconds`. */
export interface RateLimitRule {
  readonly limit: number
  readonly windowSeconds: number
}

interface Window {
  readonly startedAt: number
  readonly windowMs: number
  count: number
}

/** The most entries the table holds; beyond it the oldest is evicted. */
export const MAX_KEYS = 50_000

export class RateLimiter {
  readonly #windows = new Map<string, Window>()

  constructor(
    private readonly clock: Clock,
    private readonly maxKeys: number = MAX_KEYS,
  ) {}

  /** Count one attempt for `key`; true when it is within the rule's limit. */
  attempt(key: string, rule: RateLimitRule): boolean {
    this.hit(key, rule)
    return (this.#current(sha256Hex(key))?.count ?? 0) <= rule.limit
  }

  /** Whether `key` has already reached the rule's limit in its current window (does not count). */
  blocked(key: string, rule: RateLimitRule): boolean {
    return (this.#current(sha256Hex(key))?.count ?? 0) >= rule.limit
  }

  /** Count one attempt for `key` (does not answer). */
  hit(key: string, rule: RateLimitRule): void {
    const digest = sha256Hex(key)
    const current = this.#current(digest)
    if (current !== undefined) {
      current.count += 1
      return
    }
    this.#windows.delete(digest)
    while (this.#windows.size >= this.maxKeys) {
      const oldest = this.#windows.keys().next().value
      if (oldest === undefined) break
      this.#windows.delete(oldest)
    }
    this.#windows.set(digest, { startedAt: this.#now(), windowMs: rule.windowSeconds * 1000, count: 1 })
  }

  /** Forget a key's attempts (e.g. after a successful sign-in). */
  reset(key: string): void {
    this.#windows.delete(sha256Hex(key))
  }

  /** How many keys are tracked (tests and diagnostics). */
  size(): number {
    return this.#windows.size
  }

  /** The entry for a digest if its own window is still open. */
  #current(digest: string): Window | undefined {
    const window = this.#windows.get(digest)
    if (window === undefined || this.#now() - window.startedAt >= window.windowMs) return undefined
    return window
  }

  #now(): number {
    return Date.parse(this.clock.now())
  }
}
