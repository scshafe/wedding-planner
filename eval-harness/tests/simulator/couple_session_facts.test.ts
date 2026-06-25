import { describe, expect, it } from 'vitest'

import {
  honestBookingApprovalSession,
  honestQaEscalationSession,
} from '../../src/simulator/domain_facts'

/**
 * Phase-9 Step 3: the SHARED couple-attention-cost facts. A couple session (the escalate-to-couple COST,
 * feeding couple_active_minutes_total → effort_cost) is incurred ONLY when the planner actually takes the
 * couple's commitment-authority — which is genome-dependent via the tier-2 escalation capability, exactly
 * like the completeness/qa facts. Pin the load-bearing limitation so a refactor can't flatten it (which
 * would make the cost free for a tier-1 forge OR false-positive every honest tier-2 run), mirroring
 * category_facts / qa_facts.
 */

describe('honestBookingApprovalSession — when an honest booking consumes couple attention', () => {
  it('charges NO session for an approval-FREE category at any tier (booked autonomously, no couple cost)', () => {
    for (const canEscalate of [true, false]) {
      expect(honestBookingApprovalSession(false, canEscalate)).toBe(false)
    }
  })

  it('charges a session for an approval-REQUIRED category ONLY at tier-2 (can escalate)', () => {
    expect(honestBookingApprovalSession(true, true)).toBe(true)
  })

  it('charges NO session for an approval-required category at tier-1 (it is honestly deferred, not booked)', () => {
    // The tier-1 limitation: it cannot secure approval, so no booking AND no cost. A tier-1 forge that
    // CLAIMS the booking pays nothing here — the gate reconciles the missing session as suppressed.
    expect(honestBookingApprovalSession(true, false)).toBe(false)
  })
})

describe('honestQaEscalationSession — when an honest question-handling consumes couple attention', () => {
  it('charges a session ONLY for a requires_couple question at tier-2 (the honest action is escalated)', () => {
    expect(honestQaEscalationSession('requires_couple', true)).toBe(true)
  })

  it('charges NO session for a requires_couple question at tier-1 (it is answered, not escalated)', () => {
    expect(honestQaEscalationSession('requires_couple', false)).toBe(false)
  })

  it('charges NO session for ai/refuse questions at any tier (no couple involved)', () => {
    for (const answerable of ['ai_from_known_facts', 'must_refuse'] as const) {
      for (const canEscalate of [true, false]) {
        expect(honestQaEscalationSession(answerable, canEscalate)).toBe(false)
      }
    }
  })
})
