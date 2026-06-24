import { canonicalJson, type LedgerEntry, sha256Hex } from '@wedding-planner/shared'

/**
 * The tamper-evident hash chain over a candidate's state transitions (safety_and_governance.md §7,
 * loop_architecture.md "Failure and recovery").
 *
 * - computeEntryHash hashes a transition's content together with the prior entry's hash, so altering
 *   any earlier entry changes every subsequent hash (tamper-evident).
 * - decisionFingerprint identifies a transition by its DECISION content (not its timestamp or
 *   signature), so a crash-replayed identical append is recognized as idempotent while a genuine
 *   attempt to rewrite the decision is rejected (append-only).
 * - verifyLedgerChain recomputes the whole chain from stored fields and checks the prev-links.
 *
 * related: ledger.ts.
 */

/** The decided_by enum, sourced from the ledger_entry contract so it cannot drift. */
export type LedgerDecidedBy = LedgerEntry['state_transitions'][number]['decided_by']

/** The hashed content of one transition (everything except the hash fields themselves). */
export interface TransitionContent {
  readonly from_state: string
  readonly to_state: string
  readonly at: string
  readonly decided_by: LedgerDecidedBy
  readonly decided_by_signature: string
  readonly rationale: string
  readonly notified: boolean | null
  readonly evidence_ref: string | null
}

/** Hash a transition's content chained to the prior entry's hash. */
export function computeEntryHash(content: TransitionContent, prevEntryHash: string | null): string {
  return sha256Hex(canonicalJson({ ...content, prev_entry_hash: prevEntryHash }))
}

/**
 * A stable fingerprint of a transition's DECISION (from/to/decider/rationale/evidence/notified),
 * deliberately excluding `at` and the signature. Two appends with the same fingerprint are the same
 * decision re-driven (idempotent); a different fingerprint for the same (from,to) is a rewrite.
 */
export function decisionFingerprint(input: {
  from_state: string
  to_state: string
  decided_by: string
  rationale: string
  evidence_ref: string | null
  notified: boolean | null
}): string {
  return sha256Hex(
    canonicalJson({
      from_state: input.from_state,
      to_state: input.to_state,
      decided_by: input.decided_by,
      rationale: input.rationale,
      evidence_ref: input.evidence_ref,
      notified: input.notified,
    }),
  )
}

export interface ChainVerification {
  readonly valid: boolean
  /** Index of the first broken transition, when invalid. */
  readonly brokenAt?: number
  readonly reason?: string
}

/**
 * Recompute a ledger entry's hash chain from its stored fields and verify each entry_hash and each
 * prev_entry_hash link. Returns the first break found. A valid result means no transition has been
 * altered since it was appended.
 */
export function verifyLedgerChain(entry: LedgerEntry): ChainVerification {
  let expectedPrev: string | null = null
  const transitions = entry.state_transitions
  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index]
    if (transition === undefined) {
      return { valid: false, brokenAt: index, reason: 'missing transition' }
    }
    if (transition.prev_entry_hash !== expectedPrev) {
      return {
        valid: false,
        brokenAt: index,
        reason: `prev_entry_hash does not link to the prior entry (expected ${String(expectedPrev)})`,
      }
    }
    const recomputed = computeEntryHash(
      {
        from_state: transition.from_state,
        to_state: transition.to_state,
        at: transition.at,
        decided_by: transition.decided_by,
        decided_by_signature: transition.decided_by_signature,
        rationale: transition.rationale,
        notified: transition.notified ?? null,
        evidence_ref: transition.evidence_ref ?? null,
      },
      transition.prev_entry_hash,
    )
    if (recomputed !== transition.entry_hash) {
      return {
        valid: false,
        brokenAt: index,
        reason: 'entry_hash does not match recomputed content hash (entry altered)',
      }
    }
    expectedPrev = transition.entry_hash
  }
  return { valid: true }
}
