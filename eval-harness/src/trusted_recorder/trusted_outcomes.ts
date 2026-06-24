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
  readonly cost_cents: number
  readonly refundable: boolean
  /** The opted_in_scope that authorized an auto-execution, or null for propose-confirm. */
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

/** The input to record a commitment effect (running total is computed by the recorder). */
export type RecordCommitmentInput = Omit<TrustedCommitmentRecord, 'running_committed_cents'>

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
