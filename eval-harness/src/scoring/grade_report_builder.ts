import { getSchemaRegistry, type GradeReport } from '@wedding-planner/shared'
import { type MetricComputation } from '@wedding-planner/telemetry'

import { type GateRunResult } from '../gates/gate_runner'
import { computeNorthStar, type NorthStarComponentInputs } from './north_star'
import { CAPABILITY_VALUE_METRICS } from './scoring_constants'

/**
 * @canonical grade_report_builder -- assembles one run's gate/metric/north-star results into a
 * contract-valid grade_report (grade_report_schema.json, scoring_model.md grading pipeline).
 *
 * verdict = fail iff any veto gate failed (the ratio is then zeroed). Grading does not stop at the
 * first failure, so the report shows how far off the run was. The built report is validated against
 * the grade_report contract before it is returned.
 *
 * related: north_star.ts, gates/gate_runner.ts, telemetry metric engine.
 */

type GradeReportData = NonNullable<GradeReport['data']>
type MetricResult = GradeReportData['metric_results'][number]
type GateResultEntry = GradeReportData['gate_results'][number]
type CapabilityScore = GradeReportData['per_capability_scorecard'][number]
type Capability = CapabilityScore['capability']
type MetricDirection = MetricResult['direction']
type RubricScore = NonNullable<GradeReportData['rubric_scores']>[number]

export interface ScenarioTargetMetric {
  readonly metric_code: string
  readonly direction: MetricDirection
  readonly threshold: number
}

export interface BuildGradeReportInput {
  readonly run_id: string
  readonly scenario_id: string
  readonly couple_persona_ref?: string
  readonly guest_persona_refs?: readonly string[]
  readonly gateRun: GateRunResult
  readonly metricResults: readonly MetricComputation[]
  readonly scenarioTargetMetrics: readonly ScenarioTargetMetric[]
  readonly northStarInputs: NorthStarComponentInputs
  readonly rubricScores?: readonly RubricScore[]
  readonly meta: {
    readonly harness_version: string
    readonly started_at: string
    readonly finished_at: string
    readonly seed?: string
    readonly product_under_test_version?: string
  }
}

function metricPasses(value: number, direction: MetricDirection, threshold: number): boolean {
  switch (direction) {
    case 'lte':
    case 'min': // lower-is-better: threshold is the maximum acceptable
      return value <= threshold
    case 'gte':
    case 'max': // higher-is-better: threshold is the minimum acceptable
      return value >= threshold
    case 'eq':
      return value === threshold
  }
}

function buildMetricResults(
  metricResults: readonly MetricComputation[],
  targets: readonly ScenarioTargetMetric[],
): MetricResult[] {
  const valueByCode = new Map(metricResults.map((m) => [m.metric_code, m.value] as const))
  const results: MetricResult[] = []
  for (const target of targets) {
    const value = valueByCode.get(target.metric_code)
    if (value === undefined || value === null) {
      continue // metric not computed for this run; cannot report a value the contract requires
    }
    results.push({
      metric_code: target.metric_code,
      value,
      target: target.threshold,
      direction: target.direction,
      passed: metricPasses(value, target.direction, target.threshold),
    })
  }
  return results
}

function buildCapabilityScorecard(metricResults: readonly MetricComputation[]): CapabilityScore[] {
  const valueByCode = new Map(metricResults.map((m) => [m.metric_code, m.value] as const))
  const scorecard: CapabilityScore[] = []
  for (const [capability, metricCodes] of Object.entries(CAPABILITY_VALUE_METRICS)) {
    const available = metricCodes
      .map((code) => valueByCode.get(code))
      .filter((value): value is number => value !== undefined && value !== null)
    if (available.length === 0) {
      continue
    }
    const score = available.reduce((sum, value) => sum + value, 0) / available.length
    scorecard.push({ capability: capability as Capability, score, issues: [] })
  }
  return scorecard
}

export function buildGradeReport(input: BuildGradeReportInput): GradeReport {
  const verdict: 'pass' | 'fail' = input.gateRun.allPassed ? 'pass' : 'fail'
  const northStar = computeNorthStar(input.northStarInputs, !input.gateRun.allPassed)

  const gateResults: GateResultEntry[] = input.gateRun.results.map((result) => ({
    gate_code: result.gate_code,
    passed: result.passed,
    detail: result.detail,
    evidence: [...result.evidence],
  }))

  const data: GradeReportData = {
    run_id: input.run_id,
    scenario_id: input.scenario_id,
    ...(input.couple_persona_ref === undefined ? {} : { couple_persona_ref: input.couple_persona_ref }),
    ...(input.guest_persona_refs === undefined
      ? {}
      : { guest_persona_refs: [...input.guest_persona_refs] }),
    verdict,
    gate_results: gateResults,
    metric_results: buildMetricResults(input.metricResults, input.scenarioTargetMetrics),
    ...(input.rubricScores === undefined ? {} : { rubric_scores: [...input.rubricScores] }),
    north_star: {
      planning_value: northStar.planning_value,
      couple_cost: northStar.couple_cost,
      ratio: northStar.ratio,
    },
    per_capability_scorecard: buildCapabilityScorecard(input.metricResults),
  }

  const report: GradeReport = {
    data,
    error: null,
    meta: {
      harness_version: input.meta.harness_version,
      ...(input.meta.product_under_test_version === undefined
        ? {}
        : { product_under_test_version: input.meta.product_under_test_version }),
      started_at: input.meta.started_at,
      finished_at: input.meta.finished_at,
      ...(input.meta.seed === undefined ? {} : { seed: input.meta.seed }),
    },
  }

  return getSchemaRegistry().assertValid<GradeReport>('grade_report', report)
}
