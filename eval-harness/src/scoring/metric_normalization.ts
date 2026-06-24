import type { CouplePersona } from '@wedding-planner/shared'

import { type GuardSpec } from './accept_rule'
import { type NorthStarComponentInputs } from './north_star'
import { GUARD_DIRECTIONS, NORMALIZATION_ANCHORS } from './scoring_constants'

/**
 * Maps computed metric values into the normalized [0,1] North Star components (the metric->component
 * layer scoring_model.md describes). Phase-1 scope: quality is null (no LLM rubrics yet);
 * completeness and guest_experience are means of the available [0,1] value-metrics; the cost
 * components are normalized against NORMALIZATION_ANCHORS. Components with no signal stay null so the
 * North Star renormalizes honestly rather than scoring a gap as 0.
 *
 * related: north_star.ts (consumes these), telemetry metric engine (produces the values).
 */

export type MetricValues = Readonly<Record<string, number | null>>

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function meanOfPresent(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) {
    return null
  }
  return present.reduce((sum, value) => sum + value, 0) / present.length
}

export function deriveNorthStarInputs(
  metricValues: MetricValues,
  _couple: CouplePersona,
): NorthStarComponentInputs {
  const get = (code: string): number | null => metricValues[code] ?? null
  const activeMinutes = get('couple_active_minutes_total')
  const budgetVariancePct = get('budget_variance_pct')

  return {
    quality: null, // no LLM-judge rubric scores in Phase 1
    completeness: meanOfPresent([
      get('rsvp_resolution_rate'),
      get('qa_accuracy_rate'),
      get('category_completeness_rate'),
    ]),
    guest_experience: meanOfPresent([get('guest_sentiment_score'), get('boundary_hold_rate')]),
    effort_cost:
      activeMinutes === null
        ? null
        : clamp01(activeMinutes / NORMALIZATION_ANCHORS.worst_effort_minutes),
    money_cost:
      budgetVariancePct === null
        ? null
        : clamp01(Math.max(0, budgetVariancePct) / NORMALIZATION_ANCHORS.worst_overspend_pct),
    stress_cost: get('decision_reversal_rate'),
  }
}

/** Build GuardSpecs for a set of metric codes, using the known guard directions (skips unknowns). */
export function guardSpecsFor(metricCodes: readonly string[]): GuardSpec[] {
  const specs: GuardSpec[] = []
  for (const metricCode of metricCodes) {
    const direction = GUARD_DIRECTIONS[metricCode]
    if (direction !== undefined) {
      specs.push({ metric_code: metricCode, direction })
    }
  }
  return specs
}
