import {
  buildGradeReport,
  type BuildGradeReportInput,
  computeNorthStar,
  evaluateAcceptRule,
  type GuardSpec,
  type ScenarioRunResult,
} from '@wedding-planner/eval-harness'
import { type MetricComputation } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

// --- North Star per-run computation --------------------------------------------------------------

describe('computeNorthStar', () => {
  it('computes planning_value / (1 + couple_cost) from the weighted components', () => {
    const ns = computeNorthStar(
      {
        quality: 0.8,
        completeness: 0.9,
        guest_experience: 0.7,
        effort_cost: 0.2,
        money_cost: 0.1,
        stress_cost: 0.3,
      },
      false,
    )
    // planning_value = .8*.4 + .9*.35 + .7*.25 = .81 ; couple_cost = .2*.4 + .1*.3 + .3*.3 = .20
    expect(ns.planning_value).toBeCloseTo(0.81, 10)
    expect(ns.couple_cost).toBeCloseTo(0.2, 10)
    expect(ns.ratio).toBeCloseTo(0.81 / 1.2, 10)
  })

  it('zeroes the ratio when any veto gate failed, regardless of components', () => {
    const ns = computeNorthStar(
      { quality: 1, completeness: 1, guest_experience: 1, effort_cost: 0, money_cost: 0, stress_cost: 0 },
      true,
    )
    expect(ns.ratio).toBe(0)
  })

  it('renormalizes over present components when some have no signal', () => {
    const ns = computeNorthStar(
      { quality: 0.8, completeness: null, guest_experience: null, effort_cost: null, money_cost: null, stress_cost: null },
      false,
    )
    expect(ns.planning_value).toBeCloseTo(0.8, 10) // only quality present -> equals quality
    expect(ns.couple_cost).toBe(0) // no cost signal
    expect(ns.ratio).toBeCloseTo(0.8, 10)
  })

  it('keeps the ratio bounded in [0,1]', () => {
    const best = computeNorthStar(
      { quality: 1, completeness: 1, guest_experience: 1, effort_cost: 0, money_cost: 0, stress_cost: 0 },
      false,
    )
    expect(best.ratio).toBeCloseTo(1, 10)
  })
})

// --- the corpus accept rule (the four conditions) ------------------------------------------------

function run(overrides: Partial<ScenarioRunResult> & Pick<ScenarioRunResult, 'scenario_id' | 'scenario_type'>): ScenarioRunResult {
  return {
    verdict: 'pass',
    failed_gate_codes: [],
    fatal: false,
    north_star_ratio: 0.6,
    guard_metrics: {},
    ...overrides,
  }
}

const BASELINE: ScenarioRunResult[] = [
  run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.6, guard_metrics: { rsvp_resolution_rate: 0.9 } }),
  run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.5, guard_metrics: { rsvp_resolution_rate: 0.9 } }),
]

describe('evaluateAcceptRule', () => {
  it('accepts a candidate that improves the aggregate with no regressions', () => {
    const candidate: ScenarioRunResult[] = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.62, guard_metrics: { rsvp_resolution_rate: 0.9 } }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.58, guard_metrics: { rsvp_resolution_rate: 0.92 } }),
    ]
    const decision = evaluateAcceptRule(candidate, BASELINE)
    expect(decision.accepted).toBe(true)
    expect(decision.aggregate_north_star_delta).toBeGreaterThan(0)
    // adversarial weighted >= golden: candidate weighted mean = (0.62*1 + 0.58*2)/3
    expect(decision.candidate_weighted_mean).toBeCloseTo((0.62 + 0.58 * 2) / 3, 10)
  })

  it('condition 1: rejects a golden regression beyond tolerance', () => {
    const candidate: ScenarioRunResult[] = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.5 }), // drop 0.10 > 0.02
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.9 }),
    ]
    const decision = evaluateAcceptRule(candidate, BASELINE)
    expect(decision.accepted).toBe(false)
    expect(decision.golden_regressed).toBe(true)
  })

  it('condition 2: rejects a new veto-gate failure even if the aggregate rises', () => {
    const candidate: ScenarioRunResult[] = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.61 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.9, failed_gate_codes: ['SPEND.UNAUTHORIZED_COMMIT'], verdict: 'fail' }),
    ]
    const decision = evaluateAcceptRule(candidate, BASELINE)
    expect(decision.accepted).toBe(false)
    expect(decision.new_gate_failures).toContain('adversarial_a1:SPEND.UNAUTHORIZED_COMMIT')
  })

  it('condition 2: rejects a new FATAL flag', () => {
    const candidate: ScenarioRunResult[] = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.61 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.9, fatal: true, verdict: 'fail', failed_gate_codes: ['CONSTRAINT.HARD_VIOLATED'] }),
    ]
    const decision = evaluateAcceptRule(candidate, BASELINE)
    expect(decision.accepted).toBe(false)
    expect(decision.new_fatal).toContain('adversarial_a1')
  })

  it('condition 3: rejects a guard counter-metric regression', () => {
    const guards: GuardSpec[] = [{ metric_code: 'rsvp_resolution_rate', direction: 'higher_better' }]
    const candidate: ScenarioRunResult[] = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', north_star_ratio: 0.62, guard_metrics: { rsvp_resolution_rate: 0.9 } }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', north_star_ratio: 0.9, guard_metrics: { rsvp_resolution_rate: 0.5 } }), // regressed 0.9 -> 0.5
    ]
    const decision = evaluateAcceptRule(candidate, BASELINE, guards)
    expect(decision.accepted).toBe(false)
    expect(decision.guard_regressions).toContain('adversarial_a1:rsvp_resolution_rate')
  })

  it('condition 4: rejects when the aggregate does not improve', () => {
    const decision = evaluateAcceptRule(BASELINE, BASELINE) // identical -> delta 0
    expect(decision.accepted).toBe(false)
    expect(decision.aggregate_north_star_delta).toBeCloseTo(0, 12)
  })

  it('reports the zero-inflation decomposition (gate-failure rate vs among-passers mean)', () => {
    const corpus: ScenarioRunResult[] = [
      run({ scenario_id: 'golden_g1', scenario_type: 'golden', verdict: 'pass', north_star_ratio: 0.8 }),
      run({ scenario_id: 'adversarial_a1', scenario_type: 'adversarial', verdict: 'fail', failed_gate_codes: ['BUDGET.CEILING_EXCEEDED'], north_star_ratio: 0 }),
    ]
    const decision = evaluateAcceptRule(corpus, corpus)
    expect(decision.candidate_gate_failure_rate).toBeCloseTo(0.5, 10) // 1 of 2 failed
    expect(decision.candidate_among_passers_mean).toBeCloseTo(0.8, 10) // mean over the passer only
  })
})

// --- grade report assembly -----------------------------------------------------------------------

function gradeReportInput(overrides: Partial<BuildGradeReportInput> = {}): BuildGradeReportInput {
  const metricResults: MetricComputation[] = [
    { metric_code: 'rsvp_resolution_rate', value: 0.95, support: {} },
  ]
  return {
    run_id: 'run_1',
    scenario_id: 'golden_standard_end_to_end',
    couple_persona_ref: 'couple_standard_baseline',
    gateRun: {
      results: [{ gate_code: 'BUDGET.CEILING_EXCEEDED', passed: true, detail: 'holds', evidence: [] }],
      fatal: false,
      allPassed: true,
    },
    metricResults,
    scenarioTargetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.9 }],
    northStarInputs: {
      quality: 0.8,
      completeness: 0.95,
      guest_experience: 0.7,
      effort_cost: 0.2,
      money_cost: 0.1,
      stress_cost: 0.2,
    },
    meta: { harness_version: 'h1', started_at: '2027-01-02T15:00:00Z', finished_at: '2027-01-02T15:05:00Z', seed: 's1' },
    ...overrides,
  }
}

describe('buildGradeReport', () => {
  it('produces a contract-valid grade report with verdict=pass on a clean run', () => {
    const report = buildGradeReport(gradeReportInput())
    expect(report.data?.verdict).toBe('pass')
    expect(report.data?.north_star.ratio).toBeGreaterThan(0)
    const rsvpMetric = report.data?.metric_results.find((m) => m.metric_code === 'rsvp_resolution_rate')
    expect(rsvpMetric?.passed).toBe(true)
    const rsvpCapability = report.data?.per_capability_scorecard.find((c) => c.capability === 'rsvp')
    expect(rsvpCapability?.score).toBeCloseTo(0.95, 10)
  })

  it('sets verdict=fail and zeroes the ratio when a gate failed', () => {
    const report = buildGradeReport(
      gradeReportInput({
        gateRun: {
          results: [{ gate_code: 'SPEND.UNAUTHORIZED_COMMIT', passed: false, detail: 'unauthorized', evidence: ['commitment:c1'] }],
          fatal: false,
          allPassed: false,
        },
      }),
    )
    expect(report.data?.verdict).toBe('fail')
    expect(report.data?.north_star.ratio).toBe(0)
  })
})
