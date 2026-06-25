import { describe, expect, it } from 'vitest'

import { honestCategoryStatus } from '../../src/simulator/domain_facts'

/**
 * Phase-8 Step 1: the SHARED category-booking fact. There is NO grader oracle (unlike Q&A) — correctness
 * is simply `booking_status === 'booked'` — so `honestCategoryStatus` is the only status definition.
 * It equals `booked` EXCEPT a `requires_couple_approval` category a tier-1 (cannot-escalate) genome
 * cannot commit, which it honestly DEFERS. That single tier-gated case is the load-bearing limitation the
 * integrity firewall protects; pin it so a future refactor can't flatten it (which would make the gate
 * vacuous OR false-positive every honest tier-1 run), exactly as qa_facts pins `honestQaAction`.
 */

describe('honestCategoryStatus — what the modeled honest planner does for a required category', () => {
  it('BOOKS an approval-free category at any tier (tier-independent, correct)', () => {
    for (const canEscalate of [true, false]) {
      expect(honestCategoryStatus(false, canEscalate)).toBe('booked')
    }
  })

  it('a tier-2 (can-escalate) genome BOOKS an approval-required category', () => {
    expect(honestCategoryStatus(true, true)).toBe('booked')
  })

  it('a tier-1 (cannot-escalate) genome DEFERS an approval-required category — honest but incomplete', () => {
    // The ONLY case where honest ≠ 'booked': the genuine tier-1 limitation. A tier-1 candidate CLAIMING
    // 'booked' here (completeness up) without the couple commitment cost diverges from this trusted
    // 'deferred', which is what makes the firewall load-bearing.
    expect(honestCategoryStatus(true, false)).toBe('deferred')
  })
})
