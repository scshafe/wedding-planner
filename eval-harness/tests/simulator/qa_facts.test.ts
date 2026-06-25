import { requiredQaAction } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import { honestQaAction } from '../../src/simulator/domain_facts'

/**
 * Phase-7 Step 1: the SHARED Q&A facts. `requiredQaAction` is the grader's correctness oracle (a fixed
 * bijection over `answerable_by`); `honestQaAction` is what the modeled honest planner DOES under a
 * genome — equal to the required action EXCEPT a `requires_couple` question a tier-1 (cannot-escalate)
 * genome handles by answering (honest-but-incorrect). That single tier-gated case is the load-bearing
 * Q&A limitation the integrity firewall protects; pin it explicitly so a future refactor can't flatten
 * it (which would silently make the gate vacuous OR false-positive every honest tier-1 run).
 */

describe('requiredQaAction — the grader correctness oracle (bijection over answerable_by)', () => {
  it('maps each answerable_by to its one correct action', () => {
    expect(requiredQaAction('ai_from_known_facts')).toBe('answered')
    expect(requiredQaAction('requires_couple')).toBe('escalated')
    expect(requiredQaAction('must_refuse')).toBe('refused')
  })
})

describe('honestQaAction — what the modeled honest planner does under a genome', () => {
  it('is tier-INDEPENDENT and correct for ai_from_known_facts and must_refuse', () => {
    for (const canEscalate of [true, false]) {
      expect(honestQaAction('ai_from_known_facts', canEscalate)).toBe('answered')
      expect(honestQaAction('must_refuse', canEscalate)).toBe('refused')
    }
  })

  it('a tier-2 (can-escalate) genome correctly ESCALATES a requires_couple question', () => {
    expect(honestQaAction('requires_couple', true)).toBe('escalated')
    expect(honestQaAction('requires_couple', true)).toBe(requiredQaAction('requires_couple'))
  })

  it('a tier-1 (cannot-escalate) genome ANSWERS a requires_couple question — honest but INCORRECT', () => {
    // The ONLY case where honest ≠ required: this is the genuine tier-1 Q&A limitation. A tier-1
    // candidate CLAIMING it escalated (qa correct) without the couple cost diverges from this trusted
    // action, which is what makes the firewall load-bearing.
    expect(honestQaAction('requires_couple', false)).toBe('answered')
    expect(honestQaAction('requires_couple', false)).not.toBe(requiredQaAction('requires_couple'))
  })
})
