import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import {
  DECIDED_BY,
  HmacTransitionSigner,
  Ledger,
  STAGES,
  verifyLedgerChain,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

const CANDIDATE = 'cand_1'

function makeLedger(): { ledger: Ledger; clock: ManualClock; signer: HmacTransitionSigner } {
  const clock = new ManualClock('2027-01-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('seedLedger')
  const signer = new HmacTransitionSigner('phase1-ledger-key')
  return { ledger: new Ledger(clock, ids, signer), clock, signer }
}

function seedTwoTransitions(ledger: Ledger): void {
  ledger.append({
    candidate_id: CANDIDATE,
    from_state: STAGES.implemented,
    to_state: STAGES.offline_scoring,
    decided_by: DECIDED_BY.deterministic_selector,
    rationale: 'begin offline scoring',
  })
  ledger.append({
    candidate_id: CANDIDATE,
    from_state: STAGES.offline_scoring,
    to_state: STAGES.offline_passed,
    decided_by: DECIDED_BY.deterministic_selector,
    rationale: 'passed all four accept-rule conditions',
    evidence_ref: 'grade_report:gr_1',
  })
}

describe('ledger — hash chain', () => {
  it('builds a valid chain with correct prev-links and a contract-valid entry', () => {
    const { ledger } = makeLedger()
    seedTwoTransitions(ledger)

    const entry = ledger.getValidatedEntry(CANDIDATE)
    expect(entry.state_transitions).toHaveLength(2)
    const first = entry.state_transitions[0]
    const second = entry.state_transitions[1]
    expect(first?.prev_entry_hash).toBeNull()
    expect(second?.prev_entry_hash).toBe(first?.entry_hash)
    expect(verifyLedgerChain(entry)).toEqual({ valid: true })
  })

  it('(a) detects tampering: altering an earlier entry breaks the chain', () => {
    const { ledger } = makeLedger()
    seedTwoTransitions(ledger)
    const entry = ledger.getEntry(CANDIDATE)
    expect(entry).toBeDefined()

    // Tamper with an already-recorded transition's content (a rewrite an attacker would attempt).
    const firstTransition = entry?.state_transitions[0]
    expect(firstTransition).toBeDefined()
    if (firstTransition !== undefined) {
      firstTransition.rationale = 'forged rationale'
    }

    const verification = verifyLedgerChain(entry as Parameters<typeof verifyLedgerChain>[0])
    expect(verification.valid).toBe(false)
    expect(verification.brokenAt).toBe(0)
  })

  it('(a) detects tampering with a later entry too', () => {
    const { ledger } = makeLedger()
    seedTwoTransitions(ledger)
    const entry = ledger.getEntry(CANDIDATE)
    const second = entry?.state_transitions[1]
    if (second !== undefined) {
      second.rationale = 'forged later rationale'
    }
    const verification = verifyLedgerChain(entry as Parameters<typeof verifyLedgerChain>[0])
    expect(verification.valid).toBe(false)
    expect(verification.brokenAt).toBe(1)
  })
})

describe('ledger — append-only', () => {
  it('(b) rejects a rewrite: same (from,to) with different decision content throws', () => {
    const { ledger } = makeLedger()
    ledger.append({
      candidate_id: CANDIDATE,
      from_state: STAGES.offline_scoring,
      to_state: STAGES.offline_passed,
      decided_by: DECIDED_BY.deterministic_selector,
      rationale: 'original decision',
    })
    expect(() =>
      ledger.append({
        candidate_id: CANDIDATE,
        from_state: STAGES.offline_scoring,
        to_state: STAGES.offline_passed,
        decided_by: DECIDED_BY.deterministic_selector,
        rationale: 'a different rationale — an attempted rewrite',
      }),
    ).toThrowError(/LEDGER.APPEND_ONLY_VIOLATION|append-only/)
  })
})

describe('ledger — idempotent re-drive', () => {
  it('(c) a re-driven identical append does not fork history (even at a later time)', () => {
    const { ledger, clock } = makeLedger()
    const firstResult = ledger.append({
      candidate_id: CANDIDATE,
      from_state: STAGES.offline_scoring,
      to_state: STAGES.offline_passed,
      decided_by: DECIDED_BY.deterministic_selector,
      rationale: 'passed offline',
      evidence_ref: 'grade_report:gr_1',
    })
    expect(firstResult.idempotent).toBe(false)
    const originalHash = firstResult.transition.entry_hash

    // Simulate a crash-replay: the same turn is re-driven after the clock has advanced.
    clock.advance(5_000)
    const replayResult = ledger.append({
      candidate_id: CANDIDATE,
      from_state: STAGES.offline_scoring,
      to_state: STAGES.offline_passed,
      decided_by: DECIDED_BY.deterministic_selector,
      rationale: 'passed offline',
      evidence_ref: 'grade_report:gr_1',
    })

    expect(replayResult.idempotent).toBe(true)
    const entry = ledger.getEntry(CANDIDATE)
    expect(entry?.state_transitions).toHaveLength(1) // no fork, no duplicate
    expect(replayResult.transition.entry_hash).toBe(originalHash) // original preserved
    expect(verifyLedgerChain(ledger.getValidatedEntry(CANDIDATE))).toEqual({ valid: true })
  })
})

describe('ledger — decided_by signature binding', () => {
  it('signs each transition so decided_by cannot be spoofed', () => {
    const { ledger, signer } = makeLedger()
    const { transition } = ledger.append({
      candidate_id: CANDIDATE,
      from_state: STAGES.implemented,
      to_state: STAGES.offline_scoring,
      decided_by: DECIDED_BY.deterministic_selector,
      rationale: 'begin scoring',
    })

    const payload = {
      from_state: transition.from_state,
      to_state: transition.to_state,
      at: transition.at,
      rationale: transition.rationale,
      evidence_ref: transition.evidence_ref ?? null,
      notified: transition.notified ?? null,
    }
    // The genuine decider verifies; a different claimed decider does not.
    expect(signer.verify(transition.decided_by_signature, DECIDED_BY.deterministic_selector, payload)).toBe(
      true,
    )
    expect(signer.verify(transition.decided_by_signature, DECIDED_BY.circuit_breaker, payload)).toBe(
      false,
    )
  })
})
