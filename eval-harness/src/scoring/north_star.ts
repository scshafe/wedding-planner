import { EvalHarnessError } from '../eval_harness_error'
import { COUPLE_COST_WEIGHTS, PLANNING_VALUE_WEIGHTS } from './scoring_constants'

/**
 * @canonical north_star -- the per-run North Star computation (scoring_model.md).
 *
 *   planning_value = weighted mean of quality, completeness, guest_experience       (numerator)
 *   couple_cost    = weighted mean of effort, money, stress                          (denominator)
 *   north_star.ratio = planning_value / (1 + couple_cost)  in [0,1]; 0 if any gate failed.
 *
 * Bounded division (never divides by zero), monotonic in both directions: the loop wins by raising
 * outcome quality OR lowering couple cost. A component with no data (null) is dropped and the
 * remaining weights renormalize — honest about partial signal rather than coercing a missing
 * component to 0 or 1 (which would silently bias the score).
 */

/** Normalized [0,1] inputs to the North Star for one run. Null = no signal for that component. */
export interface NorthStarComponentInputs {
  /** Outcome quality from rubric scores. */
  readonly quality: number | null
  /** Completeness (category/rsvp/qa rates). */
  readonly completeness: number | null
  /** Guest experience (sentiment, boundary hold). */
  readonly guest_experience: number | null
  /** Couple effort cost (0 = at/under target, 1 = at worst tolerated). */
  readonly effort_cost: number | null
  /** Money cost (0 = at/under budget, 1 = at worst tolerated). */
  readonly money_cost: number | null
  /** Stress cost (reversals, needless escalations, over-automation regret). */
  readonly stress_cost: number | null
}

export interface NorthStar {
  readonly planning_value: number
  readonly couple_cost: number
  readonly ratio: number
}

interface WeightedPart {
  readonly value: number | null
  readonly weight: number
}

/** Weighted mean over the parts that have data; renormalizes weights to the present parts. */
function weightedMeanOfPresent(parts: readonly WeightedPart[]): number {
  const present = parts.filter((part): part is { value: number; weight: number } => part.value !== null)
  if (present.length === 0) {
    return 0
  }
  const totalWeight = present.reduce((sum, part) => sum + part.weight, 0)
  if (totalWeight === 0) {
    return 0
  }
  return present.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight
}

/**
 * Each non-null component must already be normalized to [0,1]. Throwing here (rather than clamping)
 * keeps the boundedness guarantee honest and is the tripwire for the future metric->component
 * normalization layer: an un-clamped normalized metric (e.g. an unbounded `max` index) that exceeds
 * 1 fails loudly instead of silently producing a ratio > 1.
 */
function assertUnitInterval(value: number | null, componentName: string): void {
  if (value !== null && (Number.isNaN(value) || value < 0 || value > 1)) {
    throw new EvalHarnessError(
      'SCORING.COMPONENT_OUT_OF_RANGE',
      `North Star component '${componentName}' must be normalized to [0,1], got ${value}.`,
      { context: { componentName, value } },
    )
  }
}

/**
 * Compute the North Star for one run. `anyVetoGateFailed` zeroes the ratio for selection purposes
 * (scoring_model.md §1) — no rubric score buys back a breached gate.
 */
export function computeNorthStar(
  inputs: NorthStarComponentInputs,
  anyVetoGateFailed: boolean,
): NorthStar {
  assertUnitInterval(inputs.quality, 'quality')
  assertUnitInterval(inputs.completeness, 'completeness')
  assertUnitInterval(inputs.guest_experience, 'guest_experience')
  assertUnitInterval(inputs.effort_cost, 'effort_cost')
  assertUnitInterval(inputs.money_cost, 'money_cost')
  assertUnitInterval(inputs.stress_cost, 'stress_cost')
  const planningValue = weightedMeanOfPresent([
    { value: inputs.quality, weight: PLANNING_VALUE_WEIGHTS.quality },
    { value: inputs.completeness, weight: PLANNING_VALUE_WEIGHTS.completeness },
    { value: inputs.guest_experience, weight: PLANNING_VALUE_WEIGHTS.guest_experience },
  ])
  const coupleCost = weightedMeanOfPresent([
    { value: inputs.effort_cost, weight: COUPLE_COST_WEIGHTS.effort },
    { value: inputs.money_cost, weight: COUPLE_COST_WEIGHTS.money },
    { value: inputs.stress_cost, weight: COUPLE_COST_WEIGHTS.stress },
  ])
  return {
    planning_value: planningValue,
    couple_cost: coupleCost,
    ratio: anyVetoGateFailed ? 0 : planningValue / (1 + coupleCost),
  }
}
