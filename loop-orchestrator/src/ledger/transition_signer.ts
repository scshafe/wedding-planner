import { canonicalJson, hmacSha256Hex, timingSafeEqualHex } from '@wedding-planner/shared'

/**
 * Signs a ledger transition so `decided_by` is bound to the deciding process's identity rather than
 * trusted as a bare string (safety_and_governance.md §7: "decided_by is bound to the deciding
 * process's identity ... not a self-set string a forged entry could spoof").
 *
 * Phase 1 uses an injected HMAC key. True out-of-process, per-decider key custody is a production
 * trusted-evidence-channel concern ([[prod-trusted-evidence-channel]]) and is out of scope here —
 * recorded in ADR 0001. The signed payload binds decided_by together with the decision content, so
 * a transition cannot claim a different decider or different content under the same signature.
 *
 * related: ledger.ts, ledger_hashing.ts.
 */
export interface TransitionSigner {
  /** Produce a signature binding `decidedBy` to the decision payload. */
  sign(decidedBy: string, payload: Record<string, unknown>): string
  /** Verify a signature against `decidedBy` and the decision payload. */
  verify(signature: string, decidedBy: string, payload: Record<string, unknown>): boolean
}

export class HmacTransitionSigner implements TransitionSigner {
  constructor(private readonly key: string) {}

  sign(decidedBy: string, payload: Record<string, unknown>): string {
    return hmacSha256Hex(this.key, canonicalJson({ decided_by: decidedBy, payload }))
  }

  verify(signature: string, decidedBy: string, payload: Record<string, unknown>): boolean {
    return timingSafeEqualHex(signature, this.sign(decidedBy, payload))
  }
}
