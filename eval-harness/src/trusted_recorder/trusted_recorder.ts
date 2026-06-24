import { deepFreeze } from '@wedding-planner/shared'

import { EvalHarnessError } from '../eval_harness_error'
import {
  type RecordCommitmentInput,
  type RecordIntegrationActionInput,
  type TrustedCommitmentRecord,
  type TrustedIntegrationActionRecord,
} from './trusted_outcomes'

/**
 * @canonical trusted_recorder -- the integrity boundary; the harness's out-of-band record of the
 * product's ACTUAL (sandboxed) effects, authored by the harness and never by the product.
 *
 * This is the project's #1 safety boundary (safety_and_governance.md §1, telemetry/README.md
 * "Integrity"). The veto gates read security-relevant ground truth from THIS recorder, not from the
 * product's self-reported telemetry. The firewall therefore protects the gates' *inputs*, not just
 * their code: a product-only change can forge or suppress its own events, but it cannot reach into
 * this recorder.
 *
 * Three properties make that real, and are enforced here, not asserted:
 *  1. Single authorship — the only writers are the record* methods, the sandbox/harness interface.
 *     No method accepts a product-supplied value for a trusted field.
 *  2. Recorder-computed totals — running_committed_cents is computed cumulatively here, never taken
 *     from the product. The product cannot under-report the committed total to dodge BUDGET.
 *  3. Immutable, append-only records — each effect is recorded once and deep-frozen; a gate (or
 *     anything downstream) cannot mutate the trusted record it reads. After `seal()`, no further
 *     effect may be recorded, so a gate that has read `totalCommittedCents()` cannot have the total
 *     changed under it by a late record (a TOCTOU the gate runner closes by sealing before scoring).
 *
 * DEFERRED FEED-PATH INVARIANT (Phase 2, the highest-leverage thing to get right then): in Phase 1
 * the caller of record* IS the harness's sandbox, so the supplied values ARE trusted observations.
 * When the real interception layer is built, the value passed to `recordCommitment({ verified, ... })`
 * MUST come from the harness observing the sandboxed call return — never from anything the product
 * authored. The input type should be branded so a product-authored value cannot be passed by accident
 * ([[prod-trusted-evidence-channel]]); recorded as a later-phase contract change, not done here.
 *
 * related: trusted_outcomes.ts, gates/integrity_gate.ts, gates/report_event_names.ts, gates/* (all read here).
 */
export class TrustedRecorder {
  private readonly commitmentsById = new Map<string, TrustedCommitmentRecord>()
  private readonly integrationActionsById = new Map<string, TrustedIntegrationActionRecord>()
  private runningCommittedCents = 0
  private sealed = false

  /**
   * Record the sandbox-observed outcome of one commitment effect. The running committed total is
   * computed here (verified commitments add their cost) and stamped onto the frozen record. Throws
   * TRUSTED_RECORDER.DUPLICATE_EFFECT if this commitment was already recorded (append-only).
   */
  recordCommitment(input: RecordCommitmentInput): TrustedCommitmentRecord {
    this.assertNotSealed('commitment', input.commitment_id)
    if (this.commitmentsById.has(input.commitment_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Commitment ${input.commitment_id} was already recorded; the trusted record is append-only.`,
        { context: { commitment_id: input.commitment_id } },
      )
    }
    if (input.verified) {
      this.runningCommittedCents += input.cost_cents
    }
    const record = deepFreeze<TrustedCommitmentRecord>({
      ...input,
      running_committed_cents: this.runningCommittedCents,
    })
    this.commitmentsById.set(input.commitment_id, record)
    return record
  }

  /** Record the sandbox-observed outcome of one external integration action (booking/send). */
  recordIntegrationAction(input: RecordIntegrationActionInput): TrustedIntegrationActionRecord {
    this.assertNotSealed('integration', input.action_id)
    if (this.integrationActionsById.has(input.action_id)) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.DUPLICATE_EFFECT',
        `Integration action ${input.action_id} was already recorded; the trusted record is append-only.`,
        { context: { action_id: input.action_id } },
      )
    }
    const record = deepFreeze<TrustedIntegrationActionRecord>({ ...input })
    this.integrationActionsById.set(input.action_id, record)
    return record
  }

  /**
   * Seal the recorder: no further effect may be recorded. The gate runner calls this before scoring
   * so a gate that has read the trusted record cannot have it changed under it by a late record.
   */
  seal(): void {
    this.sealed = true
  }

  /** Whether the recorder has been sealed. */
  isSealed(): boolean {
    return this.sealed
  }

  private assertNotSealed(effectKind: string, effectId: string): void {
    if (this.sealed) {
      throw new EvalHarnessError(
        'TRUSTED_RECORDER.SEALED',
        `Cannot record ${effectKind} ${effectId}: the trusted recorder is sealed (scoring has begun).`,
        { context: { effectKind, effectId } },
      )
    }
  }

  /** The trusted record for one commitment, or undefined if the sandbox observed no such effect. */
  commitment(commitmentId: string): TrustedCommitmentRecord | undefined {
    return this.commitmentsById.get(commitmentId)
  }

  /** All trusted commitment records, in the order the sandbox observed them. */
  allCommitments(): readonly TrustedCommitmentRecord[] {
    return [...this.commitmentsById.values()]
  }

  /** The trusted record for one integration action, or undefined if none was observed. */
  integrationAction(actionId: string): TrustedIntegrationActionRecord | undefined {
    return this.integrationActionsById.get(actionId)
  }

  /** All trusted integration action records, in observation order. */
  allIntegrationActions(): readonly TrustedIntegrationActionRecord[] {
    return [...this.integrationActionsById.values()]
  }

  /** The trusted cumulative committed spend (sum of verified commitments). Feeds BUDGET.CEILING. */
  totalCommittedCents(): number {
    return this.runningCommittedCents
  }
}
