import {
  ACCEPT_TOLERANCES,
  computeNorthStar,
  evaluateAcceptRule,
  type GuardSpec,
  type ScenarioRunResult,
  weightedMeanRatio,
} from '@wedding-planner/eval-harness'
import { describe, expect, it } from 'vitest'

/**
 * Hardening tests from the testineer review of the offline accept rule. The per-run scorer was sound;
 * the corpus aggregation trusted the candidate to submit an honest, complete, fixed corpus. These
 * pin: composition-invariance (no add/drop gaming), the four-condition conjunction (a dropped conjunct
 * is caught), the tolerance boundaries, the zero-inflation decomposition, and the weighting direction.
 */

function run(
  overrides: Partial<ScenarioRunResult> &
    Pick<ScenarioRunResult, 'scenario_id' | 'scenario_type'>,
): ScenarioRunResult {
  return { verdict: 'pass', failed_gate_codes: [], fatal: false, north_star_ratio: 0.6, guard_metrics: {}, ...overrides }
}

const GUARD: GuardSpec[] = [{ metric_code: 'g', direction: 'higher_better' }]

// Baseline corpus: one golden, one adversarial.
const baseline = (): ScenarioRunResult[] => [
  run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6, guard_metrics: { g: 0.9 } }),
  run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.5, guard_metrics: { g: 0.9 } }),
]

// --- P0: composition-gaming is rejected ----------------------------------------------------------

describe('accept rule — corpus composition gaming (P0)', () => {
  it('rejects a candidate that ADDS an easy scenario not in the baseline', () => {
    const candidate = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6, guard_metrics: { g: 0.9 } }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.5, guard_metrics: { g: 0.9 } }),
      run({ scenario_id: 'golden_easy', scenario_type: 'golden', north_star_ratio: 0.99 }), // padding
    ]
    const decision = evaluateAcceptRule(candidate, baseline(), GUARD)
    expect(decision.accepted).toBe(false)
    expect(decision.corpus_mismatch).toBe(true)
  })

  it('rejects a candidate that DROPS a hard scenario from the baseline', () => {
    const candidate = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6 }),
      // adversarial_a1 dropped
    ]
    const decision = evaluateAcceptRule(candidate, baseline(), GUARD)
    expect(decision.accepted).toBe(false)
    expect(decision.corpus_mismatch).toBe(true)
  })

  it('with a fixed corpus, a candidate cannot bypass the guard check via a new scenario', () => {
    // The only way to introduce a guard-trampling scenario is to add it -> corpus_mismatch -> reject.
    const candidate = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.61, guard_metrics: { g: 0.9 } }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.55, guard_metrics: { g: 0.9 } }),
      run({ scenario_id: 'adversarial_new', scenario_type: 'adversarial', north_star_ratio: 0.95, guard_metrics: { g: 0.01 } }),
    ]
    expect(evaluateAcceptRule(candidate, baseline(), GUARD).accepted).toBe(false)
  })
})

// --- P0: the four-condition conjunction (a dropped conjunct is caught) ----------------------------

describe('accept rule — conjunction oracle (P0)', () => {
  // An all-pass candidate over the SAME corpus: improves the aggregate, no regressions.
  const allPassCandidate = (): ScenarioRunResult[] => [
    run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.62, guard_metrics: { g: 0.9 } }),
    run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.58, guard_metrics: { g: 0.92 } }),
  ]

  it('accepts when ALL four conditions hold', () => {
    expect(evaluateAcceptRule(allPassCandidate(), baseline(), GUARD).accepted).toBe(true)
  })

  it('violating ONLY condition 1 (golden regression) flips accepted to false', () => {
    const candidate = allPassCandidate()
    candidate[0] = run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.5, guard_metrics: { g: 0.9 } })
    const decision = evaluateAcceptRule(candidate, baseline(), GUARD)
    expect(decision.accepted).toBe(false)
    expect(decision.golden_regressed).toBe(true)
  })

  it('violating ONLY condition 2 (new gate failure) flips accepted to false', () => {
    const candidate = allPassCandidate()
    candidate[1] = run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.58, guard_metrics: { g: 0.92 }, failed_gate_codes: ['SPEND.UNAUTHORIZED_COMMIT'], verdict: 'fail' })
    const decision = evaluateAcceptRule(candidate, baseline(), GUARD)
    expect(decision.accepted).toBe(false)
    expect(decision.new_gate_failures).toContain('adversarial_a1:SPEND.UNAUTHORIZED_COMMIT')
  })

  it('violating ONLY condition 2 (new FATAL) flips accepted to false', () => {
    const candidate = allPassCandidate()
    candidate[1] = run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.58, guard_metrics: { g: 0.92 }, fatal: true })
    const decision = evaluateAcceptRule(candidate, baseline(), GUARD)
    expect(decision.accepted).toBe(false)
    expect(decision.new_fatal).toContain('adversarial_a1')
  })

  it('violating ONLY condition 3 (guard regression) flips accepted to false (the deletable conjunct)', () => {
    const candidate = allPassCandidate()
    candidate[1] = run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.58, guard_metrics: { g: 0.5 } })
    const decision = evaluateAcceptRule(candidate, baseline(), GUARD)
    expect(decision.accepted).toBe(false)
    expect(decision.guard_regressions).toContain('adversarial_a1:g')
  })

  it('violating ONLY condition 4 (no aggregate improvement) flips accepted to false', () => {
    const decision = evaluateAcceptRule(baseline(), baseline(), GUARD) // identical -> delta 0
    expect(decision.accepted).toBe(false)
    expect(decision.aggregate_north_star_delta).toBeCloseTo(0, 12)
  })
})

// --- P1: tolerance boundaries --------------------------------------------------------------------

describe('accept rule — tolerance boundaries (P1)', () => {
  it('a golden drop of exactly the tolerance is NOT a regression; one epsilon more is', () => {
    const at = (ratio: number): boolean =>
      evaluateAcceptRule(
        [run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: ratio }), run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.5 })],
        baseline(),
      ).golden_regressed
    expect(at(0.6 - ACCEPT_TOLERANCES.golden_ratio)).toBe(false) // exactly at tolerance
    expect(at(0.6 - ACCEPT_TOLERANCES.golden_ratio - 0.0001)).toBe(true) // just past
    expect(at(0.6 - ACCEPT_TOLERANCES.golden_ratio + 0.0001)).toBe(false) // just inside
  })

  it('a guard drop of exactly the tolerance is NOT a regression; one epsilon more is', () => {
    const at = (guardValue: number): boolean =>
      evaluateAcceptRule(
        [run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6, guard_metrics: { g: 0.9 } }), run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.5, guard_metrics: { g: guardValue } })],
        baseline(),
        GUARD,
      ).guard_regressions.length > 0
    expect(at(0.9 - ACCEPT_TOLERANCES.guard)).toBe(false)
    expect(at(0.9 - ACCEPT_TOLERANCES.guard - 0.0001)).toBe(true)
  })
})

// --- P1: zero-inflation decomposition ------------------------------------------------------------

describe('accept rule — decomposition (P1)', () => {
  it('among-passers mean excludes failers (even a non-zero stale ratio)', () => {
    const corpus = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', verdict: 'pass', north_star_ratio: 0.8 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', verdict: 'fail', failed_gate_codes: ['BUDGET.CEILING_EXCEEDED'], north_star_ratio: 0.7 }), // stale non-zero
    ]
    const decision = evaluateAcceptRule(corpus, corpus)
    expect(decision.candidate_gate_failure_rate).toBeCloseTo(0.5, 10)
    expect(decision.candidate_among_passers_mean).toBeCloseTo(0.8, 10) // 0.7 failer excluded, not averaged in
  })

  it('reports baseline and candidate decompositions independently', () => {
    const baselineCorpus = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', verdict: 'pass', north_star_ratio: 0.8 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', verdict: 'fail', failed_gate_codes: ['X'], north_star_ratio: 0 }),
    ]
    const candidateCorpus = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', verdict: 'pass', north_star_ratio: 0.9 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', verdict: 'pass', north_star_ratio: 0.5, failed_gate_codes: [] }),
    ]
    const decision = evaluateAcceptRule(candidateCorpus, baselineCorpus)
    expect(decision.baseline_gate_failure_rate).toBeCloseTo(0.5, 10)
    expect(decision.candidate_gate_failure_rate).toBeCloseTo(0, 10)
    expect(decision.baseline_among_passers_mean).toBeCloseTo(0.8, 10)
    expect(decision.candidate_among_passers_mean).toBeCloseTo(0.7, 10) // (0.9 + 0.5)/2
  })
})

// --- P1: weighting direction + metamorphic -------------------------------------------------------

describe('weightedMeanRatio — adversarial weighted >= golden (P1)', () => {
  it('weights adversarial 2:1 over golden', () => {
    const mean = weightedMeanRatio([
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.9 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.3 }),
    ])
    expect(mean).toBeCloseTo((0.9 + 0.3 * 2) / 3, 10) // = 0.5; a swap would give 0.7
  })

  it('raising an adversarial ratio moves the mean at least as much as raising a golden ratio', () => {
    const base = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.5 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.5 }),
    ]
    const baseMean = weightedMeanRatio(base)
    const raiseGolden = weightedMeanRatio([
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.5 }),
    ])
    const raiseAdversarial = weightedMeanRatio([
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.5 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.6 }),
    ])
    expect(raiseAdversarial - baseMean).toBeGreaterThanOrEqual(raiseGolden - baseMean)
  })
})

// --- P1: pre-existing failures are not counted new -----------------------------------------------

describe('accept rule — pre-existing failures (P1)', () => {
  it('does not count a pre-existing FATAL or failed gate as new (no spurious over-rejection)', () => {
    const baselineCorpus = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.4, verdict: 'fail', fatal: true, failed_gate_codes: ['CONSTRAINT.HARD_VIOLATED'] }),
    ]
    const candidateCorpus = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.4, verdict: 'fail', fatal: true, failed_gate_codes: ['CONSTRAINT.HARD_VIOLATED'] }),
    ]
    const decision = evaluateAcceptRule(candidateCorpus, baselineCorpus)
    expect(decision.new_fatal).toEqual([])
    expect(decision.new_gate_failures).toEqual([])
  })
})

// --- P2: boundedness property + degenerate corpora -----------------------------------------------

describe('computeNorthStar — boundedness (P2)', () => {
  it('keeps ratio in [0,1] across a grid of valid component inputs', () => {
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      for (const c of [0, 0.5, 1]) {
        const ns = computeNorthStar(
          { quality: q, completeness: c, guest_experience: 0.5, effort_cost: c, money_cost: q, stress_cost: 0.5 },
          false,
        )
        expect(ns.ratio).toBeGreaterThanOrEqual(0)
        expect(ns.ratio).toBeLessThanOrEqual(1)
      }
    }
  })

  it('throws (tripwire) on an out-of-range component instead of producing ratio > 1', () => {
    expect(() =>
      computeNorthStar(
        { quality: 1.3, completeness: null, guest_experience: null, effort_cost: null, money_cost: null, stress_cost: null },
        false,
      ),
    ).toThrowError(/COMPONENT_OUT_OF_RANGE|\[0,1\]/)
  })
})

describe('accept rule — empty corpus (P2)', () => {
  it('rejects an empty corpus (no improvement to show)', () => {
    expect(evaluateAcceptRule([], []).accepted).toBe(false)
  })
})
