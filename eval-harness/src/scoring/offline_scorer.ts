import {
  type Clock,
  type CouplePersona,
  type EventEnvelope,
  type GradeReport,
  type GuestPersona,
  type IdGenerator,
} from '@wedding-planner/shared'
import { type MetricComputation, type MetricEngine } from '@wedding-planner/telemetry'

import { runVetoGates } from '../gates/gate_runner'
import { type TrustedRecorder } from '../trusted_recorder/trusted_recorder'
import {
  type AcceptDecision,
  evaluateAcceptRule,
  type GuardSpec,
  type ScenarioRunResult,
  type ScenarioType,
} from './accept_rule'
import { buildGradeReport, type ScenarioTargetMetric } from './grade_report_builder'
import { deriveNorthStarInputs, type MetricValues } from './metric_normalization'

/**
 * @canonical offline_scorer -- runs a candidate (and the baseline) across the whole corpus and
 * produces the grade reports + the accept decision (eval-harness/README.md run contract,
 * scoring_model.md). This is the fitness function the loop calls; the loop's deterministic selector
 * (loop-orchestrator) consumes the result and writes the ledger.
 *
 * For each scenario × variant: run the product (a Phase-1 sandbox stub injected as ProductRunner) to
 * get the trusted record + product events, SEAL the recorder, run the veto gates over the trusted
 * stream, compute metrics, and build a grade report. Then apply the four-condition accept rule over
 * the candidate vs baseline corpus.
 */

/**
 * One category the couple needs booked (Phase 8 plan-state ground truth). Lives on the runtime
 * ScenarioDefinition — NOT in any JSON Schema — exactly like `bookedPlanFacts`: it is a plan-state
 * simulator/grader fact with no LLM role-player (the distinguishing test from `guest_persona.questions`,
 * which a role-player consumes). Keeping it runtime-only also makes the "category-bearing scenarios are
 * KEYSTONE-ONLY" invariant structural — it cannot leak into the YAML persona corpus the loader ingests,
 * so the search cube/matrix pins are protected by construction. `category` is provenance only (the metric
 * reads category_id + booking_status); `requires_couple_approval` is the trusted-internal driver of the
 * honest booking status (tier-2 commitment-authority gates an approval-required category).
 */
export interface RequiredCategory {
  readonly category_id: string
  readonly category: string
  readonly requires_couple_approval: boolean
  /**
   * PHASE 10 — does this category have a couple vision preference its booked selection should align to? A
   * `vision_sensitive` booked category is aligned (vision_match 1.0) only by a genome that can CONSULT the
   * couple (tier-2, paying a `vision_consult` couple session); a tier-1 genome books a DEFAULT (0.5)
   * selection. Orthogonal to `requires_couple_approval` (a category can be approval-free yet
   * vision-sensitive — the cleanest keystone shape, where completeness is held and vision is the sole
   * mover). Absent/false ⇒ aligned by default at no cost, NO `category.vision.aligned` claim — which keeps
   * the vision-free search corpus byte-identical (the metric is null there, `quality` stays null). Like
   * `requires_couple_approval`, runtime-only (NOT in any JSON Schema), so vision-bearing scenarios are
   * KEYSTONE-ONLY by construction.
   */
  readonly vision_sensitive?: boolean
}

export interface ScenarioDefinition {
  readonly scenario_id: string
  readonly scenario_type: ScenarioType
  readonly couple: CouplePersona
  readonly guests: readonly GuestPersona[]
  readonly bookedPlanFacts: Readonly<Record<string, string>>
  readonly targetMetrics: readonly ScenarioTargetMetric[]
  /** Categories the couple needs booked (Phase 8). Absent/empty ⇒ no category scoring (search corpus). */
  readonly required_categories?: readonly RequiredCategory[]
}

export interface ScenarioExecution {
  readonly recorder: TrustedRecorder
  readonly productEvents: readonly EventEnvelope[]
}

export type ProductVariant = 'baseline' | 'candidate'

/** The Phase-1 sandbox stub: produce the trusted record + product events for a scenario × variant. */
export type ProductRunner = (
  scenario: ScenarioDefinition,
  variant: ProductVariant,
) => ScenarioExecution

export interface PerScenarioScore {
  readonly scenario_id: string
  readonly scenario_type: ScenarioType
  readonly run_id: string
  readonly grade_report: GradeReport
  readonly scenario_run_result: ScenarioRunResult
  readonly metric_values: MetricValues
}

export interface OfflineScoreResult {
  readonly decision: AcceptDecision
  readonly candidate: readonly PerScenarioScore[]
  readonly baseline: readonly PerScenarioScore[]
}

export interface ScoreCandidateOfflineArgs {
  readonly corpus: readonly ScenarioDefinition[]
  readonly runner: ProductRunner
  readonly guards: readonly GuardSpec[]
  readonly metricEngine: MetricEngine
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly harnessVersion: string
  readonly seed?: string
}

function failedGateCodes(gateResults: readonly { gate_code: string; passed: boolean }[]): string[] {
  return gateResults.filter((result) => !result.passed).map((result) => result.gate_code)
}

function metricValuesFrom(computations: readonly MetricComputation[]): MetricValues {
  const values: Record<string, number | null> = {}
  for (const computation of computations) {
    values[computation.metric_code] = computation.value
  }
  return values
}

function scoreOneRun(
  scenario: ScenarioDefinition,
  variant: ProductVariant,
  args: ScoreCandidateOfflineArgs,
): PerScenarioScore {
  const execution = args.runner(scenario, variant)
  execution.recorder.seal() // close the record-after-read TOCTOU before any gate reads

  const gateRun = runVetoGates({
    recorder: execution.recorder,
    productEvents: execution.productEvents,
    couple: scenario.couple,
    guests: scenario.guests,
    bookedPlanFacts: scenario.bookedPlanFacts,
  })

  const metricComputations = args.metricEngine.computeMany(
    args.metricEngine.metricCodes(),
    execution.productEvents,
    scenario.scenario_id,
  )
  const metricValues = metricValuesFrom(metricComputations)

  const runId = args.ids.next('run')
  const startedAt = args.clock.now()
  const gradeReport = buildGradeReport({
    run_id: runId,
    scenario_id: scenario.scenario_id,
    couple_persona_ref: scenario.couple.persona_id,
    gateRun,
    metricResults: metricComputations,
    scenarioTargetMetrics: scenario.targetMetrics,
    northStarInputs: deriveNorthStarInputs(metricValues, scenario.couple),
    meta: { harness_version: args.harnessVersion, started_at: startedAt, finished_at: startedAt, ...(args.seed === undefined ? {} : { seed: args.seed }) },
  })

  const ratio = gradeReport.data?.north_star.ratio ?? 0
  return {
    scenario_id: scenario.scenario_id,
    scenario_type: scenario.scenario_type,
    run_id: runId,
    grade_report: gradeReport,
    scenario_run_result: {
      scenario_id: scenario.scenario_id,
      scenario_type: scenario.scenario_type,
      verdict: gateRun.allPassed ? 'pass' : 'fail',
      failed_gate_codes: failedGateCodes(gateRun.results),
      fatal: gateRun.fatal,
      north_star_ratio: ratio,
      guard_metrics: Object.fromEntries(
        Object.entries(metricValues).filter((entry): entry is [string, number] => entry[1] !== null),
      ),
    },
    metric_values: metricValues,
  }
}

export function scoreCandidateOffline(args: ScoreCandidateOfflineArgs): OfflineScoreResult {
  const baseline = args.corpus.map((scenario) => scoreOneRun(scenario, 'baseline', args))
  const candidate = args.corpus.map((scenario) => scoreOneRun(scenario, 'candidate', args))
  const decision = evaluateAcceptRule(
    candidate.map((score) => score.scenario_run_result),
    baseline.map((score) => score.scenario_run_result),
    args.guards,
  )
  return { decision, candidate, baseline }
}
