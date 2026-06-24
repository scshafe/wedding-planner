import {
  canonicalGenomeHash,
  canonicalJson,
  getSchemaRegistry,
  type OversightRecord,
  sha256Hex,
  type StrategyGenome,
} from '@wedding-planner/shared'

/**
 * @canonical landing_approval -- the EXOGENOUS human-approval channel that lets a tier-2 candidate
 * land, and the content-addressed landing key that binds one approval to exactly one (genome, champion)
 * promotion (Phase 4a).
 *
 * THE LOAD-BEARING INVARIANT (doddy): the loop may NEVER mint its own tier-2 approval. An approval is a
 * read-only OversightRecord supplied to the loop as input; this module only READS and MARKS-SPENT — it
 * has no method that constructs an OversightRecord. So in real autonomous operation, where no approvals
 * are supplied, every tier-2 candidate parks (absent approval => withheld), which is the safe outcome.
 * We are NOT faking a human; we model "no human approved, so it does not land". The production hardening
 * is key custody — the approval's ledger_chain.decided_by_signature must verify under an L4 human keyring
 * the loop process does not hold, so a loop-forged `reviewed_by: human` record is INTEGRITY.FORGED_CLEAR
 * (oversight_record_schema.json:112). Offline, with no separate key infra, the structural "no constructor
 * + read-only injected list" is the honest stand-in; see memory prod-trusted-evidence-channel.
 *
 * THE LANDING KEY binds the approval to WHAT the human reviewed: `sha256(canonicalJson({genome_hash,
 * champion_hash}))`. It is re-derived at the promotion seam from the CURRENT champion and the
 * content-addressed candidate genome, so:
 *  - an approval reviewed against champion A does NOT promote after the champion ratchets to B (the
 *    re-derived key changes => no match => park; the change must be re-reviewed against the new baseline);
 *  - an approval for genome G cannot promote a different genome G' (different key);
 *  - one approval authorizes one landing (markSpent makes it one-shot, defense-in-depth above the key).
 * candidate_id is deliberately NOT in the key (it is a per-proposal, content-free id that would lose both
 * which genome and which baseline the human actually reviewed).
 *
 * related: pipeline/promotion_gate.ts (the consumer), shared/strategy/genome.ts (canonicalGenomeHash).
 */

/** The content-addressed key binding one approval to landing `genome` against the standing `champion`. */
export function landingKeyFor(genome: StrategyGenome, champion: StrategyGenome): string {
  return sha256Hex(
    canonicalJson({
      landing_genome_hash: canonicalGenomeHash(genome),
      against_champion_hash: canonicalGenomeHash(champion),
    }),
  )
}

/** The human-approval gate extracted from an actionable landing approval. */
export type LandingHumanGate = NonNullable<OversightRecord['human_gate']>

/** A matched, schema-valid landing approval: the human gate plus the record id for ledger evidence. */
export interface MatchedApproval {
  readonly reviewId: string
  readonly humanGate: LandingHumanGate
}

/**
 * A READ-ONLY store over exogenously-injected oversight records. It indexes the actionable landing
 * approvals (a human-reviewed record carrying a `human_gate.binds_landing_key`) by their landing key,
 * and hands at most one out per key (one-shot via markSpent). It NEVER constructs an approval — the
 * only writes are `markSpent`, which records consumption, not authorization.
 */
export class ApprovalStore {
  private readonly byLandingKey = new Map<string, MatchedApproval>()
  private readonly spent = new Set<string>()

  /**
   * @param approvals exogenously-supplied oversight records (validated against the contract here; a
   * record that is not a human-reviewed landing approval with a binding key is ignored, not an error).
   */
  constructor(approvals: readonly OversightRecord[] = []) {
    for (const record of approvals) {
      const valid = getSchemaRegistry().assertValid<OversightRecord>('oversight_record', record)
      const gate = valid.human_gate
      // Only a HUMAN-reviewed record with a binding key is an actionable landing approval. A record
      // reviewed by anything other than `human` (an agent reviewer, a monitor) can never authorize a
      // land — the schema's additive-only rule already forbids an agent emitting `cleared`, and here we
      // additionally refuse to treat a non-human record as a landing approval at all.
      if (valid.reviewed_by !== 'human' || gate == null || gate.binds_landing_key == null) {
        continue
      }
      this.byLandingKey.set(gate.binds_landing_key, { reviewId: valid.review_id, humanGate: gate })
    }
  }

  /** The unspent landing approval for `landingKey`, or undefined (no approval, or already spent). */
  find(landingKey: string): MatchedApproval | undefined {
    if (this.spent.has(landingKey)) {
      return undefined
    }
    return this.byLandingKey.get(landingKey)
  }

  /** Mark a landing approval consumed: one approval authorizes exactly one landing. */
  markSpent(landingKey: string): void {
    this.spent.add(landingKey)
  }
}
