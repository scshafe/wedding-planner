/**
 * The shapes the trusted recorder authors — the out-of-band record of what the product's effects
 * ACTUALLY did in the sandbox, written by the harness, never by the product.
 *
 * Every field here is TRUSTED-AUTHORED (telemetry/README.md "Integrity"). The product emits its own
 * telemetry events as CLAIMS about these same effects; those claims are diffed against these records
 * by the integrity gate, but they never set a field here. The distinction between "what the sandbox
 * observed" (these types) and "what the product said" (telemetry payloads) is the whole firewall.
 *
 * related: trusted_recorder.ts, gates/integrity_gate.ts.
 */

/** What the harness's sandbox observed for one commitment (money/binding) effect. */
export interface TrustedCommitmentRecord {
  readonly commitment_id: string
  /**
   * The category or item this commitment is for (e.g. 'florals' or an item id), matched against an
   * opted_in_scope.applies_to by the SPEND gate. Trusted-observed, so the gate decides authorization
   * from the real category, not the product's claimed scope. Null means the recorder did not capture
   * a category — the SPEND gate then matches no scope (fail-safe: such an auto-commit is unauthorized).
   * Recorder-authored only; there is no product-claim path that any gate honors, so it is not part of
   * the integrity gate's field diff.
   */
  readonly applies_to_ref: string | null
  readonly cost_cents: number
  readonly refundable: boolean
  /** The opted_in_scope the product CLAIMS authorized an auto-execution, or null. The SPEND gate does
   * not trust this — it independently re-derives authorization from the couple's opted_in_scopes. */
  readonly scope_id: string | null
  /** Whether the product auto-executed this without awaiting approval (sandbox-observed). */
  readonly auto_executed: boolean
  /** Sandbox truth: did the binding action actually confirm. */
  readonly verified: boolean
  /** A genuine couple approval the recorder observed before this effect, or null if none. */
  readonly approved_by_event_id: string | null
  /** Trusted cumulative committed spend AFTER this effect — computed by the recorder, not supplied. */
  readonly running_committed_cents: number
}

/**
 * The input to record a commitment effect. The running total is computed by the recorder, and
 * applies_to_ref defaults to null when the caller omits it.
 */
export type RecordCommitmentInput = Omit<
  TrustedCommitmentRecord,
  'running_committed_cents' | 'applies_to_ref'
> & { readonly applies_to_ref?: string | null }

/** The status an external action actually resolved to in the sandbox. */
export type VerifiedStatus = 'attempted' | 'confirmed' | 'failed'

/** What the harness's sandbox observed for one external (booking/send) integration action. */
export interface TrustedIntegrationActionRecord {
  readonly action_id: string
  readonly integration_id: string
  /** Resource/slot identifier, used to detect double-booking. */
  readonly target_ref: string
  readonly method: string
  /** Sandbox truth: what the real (sandboxed) integration call actually returned. */
  readonly verified_status: VerifiedStatus
  readonly idempotency_key: string | null
  readonly availability_age_seconds: number | null
}

export type RecordIntegrationActionInput = TrustedIntegrationActionRecord

/** Grader-side determination of whether one hard constraint is satisfied by the final plan. */
export interface TrustedConstraintDetermination {
  readonly constraint_id: string
  readonly constraint_type:
    | 'date'
    | 'guest_count'
    | 'budget'
    | 'allergy'
    | 'accessibility'
    | 'cultural'
    | 'religious'
    | 'dietary'
    | 'other'
  /** Computed grader-side from the persona's hard_constraints ground truth — never set by the product. */
  readonly satisfied: boolean
  readonly severity: 'fatal' | 'serious' | 'moderate'
  readonly plan_element_ref: string | null
}

export type RecordConstraintDeterminationInput = TrustedConstraintDetermination

/** One factual claim captured at the send boundary (the actual value sent to the guest). */
export interface TrustedFactAssertion {
  readonly fact_id: string
  readonly fact_type: string
  /** The value actually sent to the guest, captured out-of-band — fact-checked against the booked plan. */
  readonly asserted_value: string
}

/**
 * The trusted capture of one guest-facing message — what was ACTUALLY sent, intercepted at the send
 * boundary (gate_checks.md: COMMS gates compute over captured sent content, not product events). The
 * grader-side determinations (mentioned secret tags, disclosed other-guest ids) are authored here.
 */
export interface TrustedGuestMessageRecord {
  readonly message_id: string
  readonly recipient_guest_id: string
  readonly fact_assertions: readonly TrustedFactAssertion[]
  /** Registered surprise tags this message reveals/hints at (grader-determined). Non-empty = leak. */
  readonly reveals_secret_tags: readonly string[]
  /** Other guests whose private data this message discloses (grader-determined). Non-empty = mis-seg. */
  readonly discloses_guest_ids: readonly string[]
}

export type RecordGuestMessageInput = TrustedGuestMessageRecord
