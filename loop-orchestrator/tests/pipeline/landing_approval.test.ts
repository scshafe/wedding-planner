import {
  getSchemaRegistry,
  type OversightRecord,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { ApprovalStore, landingKeyFor } from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

import { humanApproval } from '../fixtures/oversight_fixtures'

/**
 * Phase 4a Step 3: the exogenous human-approval channel. The landing key binds an approval to exactly
 * one (genome, champion) landing; the store is read-only over injected oversight records and hands a
 * matching approval out at most once.
 */

function g(cadence: number, spacing: number, autonomy?: number): StrategyGenome {
  return {
    genome_id: `g_${cadence}_${spacing}_${autonomy ?? 'x'}`,
    parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: spacing, ...(autonomy === undefined ? {} : { autonomy_threshold: autonomy }) },
  }
}

describe('landingKeyFor — binds an approval to (genome, champion)', () => {
  it('is deterministic and depends on BOTH the genome and the champion', () => {
    const genome = g(2, 1, 1)
    const champA = g(0, 0)
    const champB = g(3, 3)
    expect(landingKeyFor(genome, champA)).toBe(landingKeyFor(genome, champA))
    // Different champion (the ratchet) => different key: a stale approval cannot promote.
    expect(landingKeyFor(genome, champA)).not.toBe(landingKeyFor(genome, champB))
    // Different genome => different key: an approval for one genome cannot promote another.
    expect(landingKeyFor(g(2, 1, 2), champA)).not.toBe(landingKeyFor(genome, champA))
  })
})

describe('ApprovalStore — read-only, one-shot, human-only', () => {
  it('finds a matching unspent approval and makes it one-shot via markSpent', () => {
    const key = landingKeyFor(g(2, 1, 1), g(0, 0))
    const store = new ApprovalStore([humanApproval(key, true)])
    const matched = store.find(key)
    expect(matched?.humanGate.approved).toBe(true)
    store.markSpent(key)
    expect(store.find(key)).toBeUndefined() // spent: cannot be re-used for another landing
  })

  it('returns undefined for an unknown landing key', () => {
    const store = new ApprovalStore([humanApproval(landingKeyFor(g(2, 1, 1), g(0, 0)), true)])
    expect(store.find('no-such-key')).toBeUndefined()
  })

  it('ignores a non-human record (only a human review can authorize a land)', () => {
    const key = landingKeyFor(g(2, 1, 1), g(0, 0))
    // A deterministic_gate "cleared" with a binding key is NOT a human landing approval.
    const nonHuman: OversightRecord = {
      review_id: 'rev_gate', at: '2027-05-01T12:30:00.000Z', review_kind: 'inline_pre_landing',
      subject: { acting_agent: 'product_improvement_loop', action_ref: 'c', claimed_tier: 2, derived_tier: 2 },
      reviewed_by: 'deterministic_gate', reviewer_distinct_from_actor: true,
      evidence: { read_from: 'static_diff_analysis' }, verdict: 'cleared',
      human_gate: { approved: true, approver_role: 'loop_supervisor', decided_at: '2027-05-01T12:30:00.000Z', binds_landing_key: key },
      pii_redacted: true,
      ledger_chain: { entry_hash: 'h', prev_entry_hash: null, decided_by: 'deterministic_gate', decided_by_signature: 's' },
    }
    const store = new ApprovalStore([getSchemaRegistry().assertValid<OversightRecord>('oversight_record', nonHuman)])
    expect(store.find(key)).toBeUndefined()
  })

  it('an empty / default store approves nothing (the autonomous default => everything parks)', () => {
    expect(new ApprovalStore().find('any')).toBeUndefined()
    expect(new ApprovalStore([]).find('any')).toBeUndefined()
  })

  it('rejects a malformed oversight record at construction (wired to the real contract)', () => {
    expect(() => new ApprovalStore([{ review_id: 'x' } as unknown as OversightRecord])).toThrow()
  })
})
