import { type Clock, getSchemaRegistry, type IdGenerator, type LedgerEntry } from '@wedding-planner/shared'

import { type DecidedBy, type FinalDisposition } from '../loop_orchestrator_constants'
import { LoopOrchestratorError } from '../loop_orchestrator_error'
import { computeEntryHash, decisionFingerprint, type TransitionContent } from './ledger_hashing'
import { type TransitionSigner } from './transition_signer'

/**
 * @canonical ledger -- the loop's append-only, hash-chained audit record.
 *
 * One LedgerEntry per candidate, holding a hash-chained array of state transitions
 * (ledger_entry_schema.json, safety_and_governance.md §7). The store is append-only by construction:
 * there is no update/replace method. Two safety properties the loop depends on are enforced here:
 *
 *  - Idempotent appends keyed by candidate_id × from_state × to_state (loop_architecture.md "Failure
 *    and recovery"): a crash-replayed identical transition is absorbed, never double-appended or
 *    forked. (Phase 1 produces only offline transitions; ramp-step disambiguation is a later phase.)
 *  - Append-only: re-appending the same (from,to) with DIFFERENT decision content is rejected as a
 *    rewrite (LEDGER.APPEND_ONLY_VIOLATION).
 *
 * Tamper-evidence is provided by the hash chain (ledger_hashing.verifyLedgerChain).
 *
 * related: ledger_hashing.ts, transition_signer.ts.
 */

/** One transition, matching ledger_entry.state_transitions[]. */
export type StateTransition = LedgerEntry['state_transitions'][number]

/** The offline scoring result attached to a candidate's ledger entry. */
export type OfflineResult = NonNullable<LedgerEntry['offline_result']>

export interface AppendTransitionInput {
  readonly candidate_id: string
  readonly from_state: string
  readonly to_state: string
  readonly decided_by: DecidedBy
  readonly rationale: string
  readonly evidence_ref?: string | null
  readonly notified?: boolean | null
}

export interface AppendResult {
  readonly entry: LedgerEntry
  readonly transition: StateTransition
  /** True when an identical transition already existed and this append was absorbed (no fork). */
  readonly idempotent: boolean
}

const LEDGER_ID_PREFIX = 'ledger'

export class Ledger {
  private readonly entriesByCandidate = new Map<string, LedgerEntry>()

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly signer: TransitionSigner,
  ) {}

  /**
   * Append a state transition for a candidate. Idempotent on (candidate_id, from_state, to_state):
   * an identical re-drive returns the existing transition; a conflicting one throws
   * LEDGER.APPEND_ONLY_VIOLATION.
   */
  append(input: AppendTransitionInput): AppendResult {
    const entry = this.getOrCreateEntry(input.candidate_id)
    const evidenceRef = input.evidence_ref ?? null
    const notified = input.notified ?? null

    const fingerprint = decisionFingerprint({
      from_state: input.from_state,
      to_state: input.to_state,
      decided_by: input.decided_by,
      rationale: input.rationale,
      evidence_ref: evidenceRef,
      notified,
    })

    const existing = entry.state_transitions.find(
      (transition) =>
        transition.from_state === input.from_state && transition.to_state === input.to_state,
    )
    if (existing !== undefined) {
      const existingFingerprint = decisionFingerprint({
        from_state: existing.from_state,
        to_state: existing.to_state,
        decided_by: existing.decided_by,
        rationale: existing.rationale,
        evidence_ref: existing.evidence_ref ?? null,
        notified: existing.notified ?? null,
      })
      if (existingFingerprint === fingerprint) {
        return { entry, transition: existing, idempotent: true }
      }
      throw new LoopOrchestratorError(
        'LEDGER.APPEND_ONLY_VIOLATION',
        `Refusing to rewrite the existing ${input.from_state} -> ${input.to_state} transition for ` +
          `candidate ${input.candidate_id}; the ledger is append-only.`,
        {
          context: {
            candidate_id: input.candidate_id,
            from_state: input.from_state,
            to_state: input.to_state,
          },
        },
      )
    }

    const at = this.clock.now()
    const signature = this.signer.sign(input.decided_by, {
      from_state: input.from_state,
      to_state: input.to_state,
      at,
      rationale: input.rationale,
      evidence_ref: evidenceRef,
      notified,
    })
    const prevEntryHash = entry.state_transitions.at(-1)?.entry_hash ?? null
    const content: TransitionContent = {
      from_state: input.from_state,
      to_state: input.to_state,
      at,
      decided_by: input.decided_by,
      decided_by_signature: signature,
      rationale: input.rationale,
      notified,
      evidence_ref: evidenceRef,
    }
    const transition: StateTransition = {
      ...content,
      entry_hash: computeEntryHash(content, prevEntryHash),
      prev_entry_hash: prevEntryHash,
    }
    entry.state_transitions.push(transition)
    return { entry, transition, idempotent: false }
  }

  /** The live ledger entry for a candidate, or undefined if none has been started. */
  getEntry(candidateId: string): LedgerEntry | undefined {
    return this.entriesByCandidate.get(candidateId)
  }

  /** The candidate's ledger entry, validated against the ledger_entry contract. */
  getValidatedEntry(candidateId: string): LedgerEntry {
    return getSchemaRegistry().assertValid<LedgerEntry>('ledger_entry', this.requireEntry(candidateId))
  }

  /** Record the candidate's final disposition. */
  setFinalDisposition(candidateId: string, disposition: FinalDisposition): void {
    this.requireEntry(candidateId).final_disposition = disposition
  }

  /** Attach the offline scoring result to the candidate's entry. */
  setOfflineResult(candidateId: string, offlineResult: OfflineResult): void {
    this.requireEntry(candidateId).offline_result = offlineResult
  }

  /** Append a lesson for the proposer to learn from. */
  addLesson(candidateId: string, lesson: string): void {
    const entry = this.requireEntry(candidateId)
    entry.lessons = [...(entry.lessons ?? []), lesson]
  }

  /** All ledger entries (the loop's durable memory / recovery log). */
  allEntries(): LedgerEntry[] {
    return [...this.entriesByCandidate.values()]
  }

  private getOrCreateEntry(candidateId: string): LedgerEntry {
    const existing = this.entriesByCandidate.get(candidateId)
    if (existing !== undefined) {
      return existing
    }
    const created: LedgerEntry = {
      ledger_id: this.ids.next(LEDGER_ID_PREFIX),
      candidate_id: candidateId,
      state_transitions: [],
      final_disposition: null,
      lessons: [],
    }
    this.entriesByCandidate.set(candidateId, created)
    return created
  }

  private requireEntry(candidateId: string): LedgerEntry {
    const entry = this.entriesByCandidate.get(candidateId)
    if (entry === undefined) {
      throw new LoopOrchestratorError(
        'LEDGER.ENTRY_NOT_FOUND',
        `No ledger entry for candidate ${candidateId}.`,
        { context: { candidate_id: candidateId } },
      )
    }
    return entry
  }
}
