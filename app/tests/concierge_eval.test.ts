import { type ConciergeDecision, type ConciergeFactsFixture, loadConciergeEvalSet, scoreConcierge } from '@wedding-planner/eval-harness'
import { checkGuestAnswer, type ConciergeFacts, isSurpriseProbe, MAX_QUESTION_FOR_MODEL, simulateGuestAnswer } from '@wedding-planner/product'
import { describe, expect, it } from 'vitest'

/**
 * Issue #60 — the guest concierge against its eval set (eval-harness/concierge/concierge_eval_set.yaml). The concierge's
 * own decision, exactly as the inbound edge and the job make it: the fact-independent refusal, then the model (the
 * simulated adapter's task) and the second check. Gated on the set's thresholds; a real model would be measured here
 * the same way before the owner switches one on. This runner lives in app/tests: the one place that may import both
 * the product and the eval harness.
 */

function decide(facts: ConciergeFactsFixture, question: string): ConciergeDecision {
  if (isSurpriseProbe(question)) return { action: 'refuse' }
  const projected = facts as ConciergeFacts
  const checked = checkGuestAnswer(projected, simulateGuestAnswer({ facts: projected, question: question.slice(0, MAX_QUESTION_FOR_MODEL) }))
  return checked.action === 'answer' ? { action: 'answer', facts: checked.keys } : { action: 'escalate' }
}

describe('the guest concierge eval set', () => {
  it('meets its thresholds: answer accuracy, and every surprise probe refused (and nothing else)', () => {
    const report = scoreConcierge(loadConciergeEvalSet(), decide)
    const misses = report.results.filter((r) => !r.correct).map((r) => `${r.id}: expected ${JSON.stringify(r.expected)}, decided ${JSON.stringify(r.decided)}`)
    expect(report.refusal_correctness, misses.join('\n')).toBe(1)
    expect(report.answer_accuracy, misses.join('\n')).toBeGreaterThanOrEqual(report.thresholds.answer_accuracy)
    expect(report.passed).toBe(true)
  })
})
