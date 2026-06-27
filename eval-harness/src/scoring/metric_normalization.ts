import type { CouplePersona } from '@wedding-planner/shared'

import { type GuardSpec } from './accept_rule'
import { type NorthStarComponentInputs } from './north_star'
import { GUARD_DIRECTIONS, NORMALIZATION_ANCHORS } from './scoring_constants'

/**
 * Maps computed metric values into the normalized [0,1] North Star components (the metric->component
 * layer scoring_model.md describes). `quality` is the mean of the PRESENT rubrics (Phase 10) — today just
 * `vision_match_rate`, the one rubric backed offline; `comms_quality`/`intuitiveness` stay ABSENT (their
 * judge is offline-STOP-gated, ADR 0007), so the 0.40 quality weight rides this single rubric while thin —
 * a reason NOT to move vision scenarios into the search corpus (the over-weight would distort the gradient).
 * completeness and guest_experience are means of the available [0,1] value-metrics; the cost components are
 * normalized against NORMALIZATION_ANCHORS. Components with no signal stay null so the North Star
 * renormalizes honestly rather than scoring a gap as 0 — which keeps `quality` null on the search corpus
 * (no `vision_match_rate` there) so the pre-Phase-10 search landscape is byte-identical.
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
  const messagingCents = get('messaging_money_total_cents')

  // PHASE 20: money_cost now combines TWO additive money outflows — vendor overspend AND messaging spend — as
  // a SUM of their normalized [0,1] shares (architect MF3: they are additive dollars, not substitutes; `max`
  // would let one inert-ify the other and kill the messaging gradient on any over-budget scenario). Each share
  // is present-or-null; money_cost is null only when BOTH are absent (so a no-money corpus keeps it null and
  // byte-identical). On the search corpus budget_variance is null, so messaging is the SOLE money driver (and
  // couple_cost is 100% money there, effort_cost being 0) — the calibrated `worst_messaging_cents` keeps the
  // term real-but-secondary without overturning the resolution-driven cube optimum (wolf).
  const budgetShare =
    budgetVariancePct === null
      ? null
      : Math.max(0, budgetVariancePct) / NORMALIZATION_ANCHORS.worst_overspend_pct
  const messagingShare =
    messagingCents === null ? null : Math.max(0, messagingCents) / NORMALIZATION_ANCHORS.worst_messaging_cents

  return {
    // Mean of the PRESENT quality rubrics (Phase 10). Only vision_match is backed offline; the explicit
    // single-element list documents that comms_quality/intuitiveness are deliberately absent (judge→STOP),
    // and keeps `quality` null on the search corpus (vision_match_rate null there) for byte-identity.
    quality: meanOfPresent([get('vision_match_rate')]),
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
      budgetShare === null && messagingShare === null
        ? null
        : clamp01((budgetShare ?? 0) + (messagingShare ?? 0)),
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
