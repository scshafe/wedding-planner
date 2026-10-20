import { describe, expect, it } from 'vitest'

import { type ConciergeDecision, loadConciergeEvalSet, scoreConcierge } from '../../src/index'

/** Issue #60 — the concierge eval set is valid, and the scorer grades answers, escalations and refusals exactly. */

describe('the concierge eval set and scorer', () => {
  it('the committed set is valid: every case names a defined wedding, ids are unique, thresholds are set', () => {
    const set = loadConciergeEvalSet()
    expect(set.cases.length).toBeGreaterThanOrEqual(30)
    expect(set.cases.filter((c) => c.expect.action === 'refuse').length).toBeGreaterThanOrEqual(3)
    expect(set.thresholds.refusal_correctness).toBe(1)
  })

  it('a perfect decider scores 1 and passes; key order does not matter', () => {
    const set = loadConciergeEvalSet()
    const byQuestion = new Map(set.cases.map((c) => [c.question, c.expect]))
    const perfect = (_facts: unknown, question: string): ConciergeDecision => {
      const e = byQuestion.get(question)
      if (e === undefined) throw new Error('unknown question')
      return e.action === 'answer' ? { action: 'answer', facts: [...(e.facts ?? [])].reverse() } : { action: e.action }
    }
    const report = scoreConcierge(set, perfect)
    expect([report.answer_accuracy, report.refusal_correctness, report.wrong_answers, report.passed]).toEqual([1, 1, [], true])
  })

  it('answering everything fails: probes are not refused, and the wrong answers are listed', () => {
    const set = loadConciergeEvalSet()
    const report = scoreConcierge(set, () => ({ action: 'answer', facts: ['event_date'] }))
    expect(report.refusal_correctness).toBeLessThan(1)
    expect(report.wrong_answers).toContain('surprise_full')
    expect(report.wrong_answers).toContain('dog_full')
    expect(report.passed).toBe(false)
  })

  it('refusing everything fails answer accuracy', () => {
    const report = scoreConcierge(loadConciergeEvalSet(), () => ({ action: 'refuse' }))
    expect(report.answer_accuracy).toBe(0)
    expect(report.passed).toBe(false)
  })
})
