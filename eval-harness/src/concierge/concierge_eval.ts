import { readFileSync } from 'node:fs'

import { type ConciergeEvalSet, getSchemaRegistry, resolveFromRepoRoot } from '@wedding-planner/shared'
import { load as loadYaml } from 'js-yaml'

import { EvalHarnessError } from '../eval_harness_error'

/**
 * @canonical concierge_eval -- the guest concierge's eval set and its scorer (issue #60, ADR 0059).
 *
 * The set (`eval-harness/concierge/concierge_eval_set.yaml`, the `concierge_eval_set` contract) holds fixture weddings —
 * the facts a guest may be told, as the concierge projects them — and guest questions with the expected outcome:
 * answered with which fact keys, escalated, or refused. The scorer takes the concierge's decision as a function (this
 * package imports only `shared`; the runner that wires the product's concierge lives in `app/tests`) and reports:
 *   - **answer accuracy:** of the cases expecting an answer or an escalation, the share decided exactly — the action,
 *     and for an answer the same set of fact keys;
 *   - **refusal correctness:** of all cases, the share refused exactly when a refusal is expected (a surprise probe must
 *     be refused; nothing else may be);
 *   - **wrong answers:** answers given where the case expects an escalation or a refusal — the costly mistake (a guest
 *     told something the facts do not say, or a probe answered), listed by id.
 *
 * related: concierge_eval_set_schema.json (the contract), app/tests/concierge_eval.test.ts (the runner).
 */

export const CONCIERGE_EVAL_SET_PATH = 'eval-harness/concierge/concierge_eval_set.yaml'

export type ConciergeEvalCase = ConciergeEvalSet['cases'][number]
export type ConciergeFactsFixture = ConciergeEvalSet['weddings'][string]

/** What the concierge decided for one case. */
export type ConciergeDecision = { readonly action: 'answer'; readonly facts: readonly string[] } | { readonly action: 'escalate' } | { readonly action: 'refuse' }

export interface ConciergeEvalResult {
  readonly id: string
  readonly expected: ConciergeEvalCase['expect']
  readonly decided: ConciergeDecision
  readonly correct: boolean
}

export interface ConciergeEvalReport {
  readonly answer_accuracy: number
  readonly refusal_correctness: number
  /** Ids of cases answered where an escalation or a refusal was expected. */
  readonly wrong_answers: readonly string[]
  readonly results: readonly ConciergeEvalResult[]
  readonly thresholds: ConciergeEvalSet['thresholds']
  readonly passed: boolean
}

/** Load and validate the eval set (every case's wedding must be defined). */
export function loadConciergeEvalSet(repoRelativePath: string = CONCIERGE_EVAL_SET_PATH): ConciergeEvalSet {
  const parsed = loadYaml(readFileSync(resolveFromRepoRoot(repoRelativePath), 'utf8'))
  const result = getSchemaRegistry().validate<ConciergeEvalSet>('concierge_eval_set', parsed)
  if (!result.valid) {
    throw new EvalHarnessError('EVAL.CORPUS_INVALID', "The concierge eval set does not conform to the 'concierge_eval_set' contract.", {
      context: { repoRelativePath, validationErrors: result.errors },
    })
  }
  const set = result.data
  const ids = new Set<string>()
  for (const c of set.cases) {
    if (set.weddings[c.wedding] === undefined || ids.has(c.id)) {
      throw new EvalHarnessError('EVAL.CORPUS_INVALID', `Concierge case '${c.id}' names an unknown wedding or repeats an id.`, { context: { id: c.id } })
    }
    ids.add(c.id)
  }
  return set
}

/** Score a decision function over the set. */
export function scoreConcierge(set: ConciergeEvalSet, decide: (facts: ConciergeFactsFixture, question: string) => ConciergeDecision): ConciergeEvalReport {
  const results = set.cases.map((c): ConciergeEvalResult => {
    const facts = set.weddings[c.wedding] as ConciergeFactsFixture
    const decided = decide(facts, c.question)
    return { id: c.id, expected: c.expect, decided, correct: matches(c.expect, decided) }
  })
  const graded = results.filter((r) => r.expected.action !== 'refuse')
  const answer_accuracy = graded.length === 0 ? 1 : graded.filter((r) => r.correct).length / graded.length
  const refusal_correctness = results.filter((r) => (r.expected.action === 'refuse') === (r.decided.action === 'refuse')).length / results.length
  const wrong_answers = results.filter((r) => r.decided.action === 'answer' && r.expected.action !== 'answer').map((r) => r.id)
  return {
    answer_accuracy,
    refusal_correctness,
    wrong_answers,
    results,
    thresholds: set.thresholds,
    passed: answer_accuracy >= set.thresholds.answer_accuracy && refusal_correctness >= set.thresholds.refusal_correctness,
  }
}

function matches(expected: ConciergeEvalCase['expect'], decided: ConciergeDecision): boolean {
  if (expected.action !== decided.action) return false
  if (decided.action !== 'answer') return true
  const want = [...(expected.facts ?? [])].sort()
  const got = [...decided.facts].sort()
  return want.length === got.length && want.every((k, i) => k === got[i])
}
