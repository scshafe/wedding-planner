/**
 * @canonical wedding_planner_error -- the base error type for the entire system.
 *
 * Every domain-specific error extends this so that a failure always carries a
 * machine-readable `code` (DOMAIN.FAILURE_MODE), a human-readable message, a structured
 * `context` capturing state at the failure point, and a preserved `cause` chain. Agents
 * trace failures by grepping the code and reading the context; never throw a bare Error.
 *
 * related: every `*_error.ts` across the domains.
 */

export interface WeddingPlannerErrorOptions {
  /** Arbitrary key-value state captured at the failure point. Never include secrets or PII. */
  readonly context?: Record<string, unknown>
  /** The underlying error this wraps, preserved so the full failure path is reconstructable. */
  readonly cause?: unknown
}

export class WeddingPlannerError extends Error {
  /** Machine-readable code in DOMAIN.FAILURE_MODE form, e.g. `CONTRACT.VALIDATION_FAILED`. */
  readonly code: string
  /** Structured state at the failure point. */
  readonly context: Record<string, unknown>

  constructor(code: string, message: string, options: WeddingPlannerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    // new.target.name gives the concrete subclass name even when constructed via super().
    this.name = new.target.name
    this.code = code
    this.context = options.context ?? {}
  }
}
