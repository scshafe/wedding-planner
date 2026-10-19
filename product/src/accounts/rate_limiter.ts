import type { Clock } from '@wedding-planner/shared'

/**
 * @canonical rate_limiter -- in-process, fixed-window attempt counting (issue #10, ADR 0041).
 *
 * Sign-in and password-reset requests are counted per key (e.g. tenant + submitted email, and tenant-wide) in
 * fixed windows of the injected clock. Keys are whatever string the caller submits — the limiter never looks an
 * account up — so a limited response says nothing about whether an account exists.
 *
 * In-process by design (the issue allows it): one container, and a restart resetting the counters is acceptable.
 * Expired windows are pruned when the table grows past a bound, so a flood of distinct keys cannot grow memory
 * without limit.
 *
 * related: account_service.ts (the rules it applies).
 */

/** At most `limit` attempts per `windowSeconds`. */
export interface RateLimitRule {
  readonly limit: number
  readonly windowSeconds: number
}

interface Window {
  readonly startedAt: number
  count: number
}

/** Prune expired windows once the table holds this many keys. */
const PRUNE_THRESHOLD = 10_000

export class RateLimiter {
  readonly #windows = new Map<string, Window>()

  constructor(private readonly clock: Clock) {}

  /** Count one attempt for `key`; true when it is within the rule's limit. */
  attempt(key: string, rule: RateLimitRule): boolean {
    const now = Date.parse(this.clock.now())
    if (this.#windows.size >= PRUNE_THRESHOLD) this.#prune(now, rule)
    const current = this.#windows.get(key)
    if (current === undefined || now - current.startedAt >= rule.windowSeconds * 1000) {
      this.#windows.set(key, { startedAt: now, count: 1 })
      return rule.limit >= 1
    }
    current.count += 1
    return current.count <= rule.limit
  }

  /** Forget a key's attempts (e.g. after a successful sign-in). */
  reset(key: string): void {
    this.#windows.delete(key)
  }

  #prune(now: number, rule: RateLimitRule): void {
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= rule.windowSeconds * 1000) this.#windows.delete(key)
    }
  }
}
