import { getSchemaRegistry, type OversightRecord } from '@wedding-planner/shared'

/**
 * Build a schema-valid HUMAN tier-2 landing approval bound to `landingKey` (Phase 4a). This is the
 * exogenous record a human (or a future out-of-loop channel) supplies to authorize a tier-2 landing;
 * the loop never constructs one. `approved:true` clears the land, `approved:false` rejects it.
 */
export function humanApproval(landingKey: string | null, approved: boolean, reviewId = `rev_${approved}`): OversightRecord {
  const record: OversightRecord = {
    review_id: reviewId,
    at: '2027-05-01T12:30:00.000Z',
    review_kind: 'inline_pre_landing',
    subject: { acting_agent: 'product_improvement_loop', action_ref: 'cand_under_review', claimed_tier: 2, derived_tier: 2 },
    reviewed_by: 'human',
    reviewer_distinct_from_actor: true,
    evidence: { read_from: 'static_diff_analysis' },
    verdict: approved ? 'cleared' : 'blocked',
    human_gate: { approved, approver_role: 'loop_supervisor', decided_at: '2027-05-01T12:30:00.000Z', binds_landing_key: landingKey },
    pii_redacted: true,
    ledger_chain: { entry_hash: 'h0', prev_entry_hash: null, decided_by: 'human', decided_by_signature: 'sig_human' },
  }
  return getSchemaRegistry().assertValid<OversightRecord>('oversight_record', record)
}
