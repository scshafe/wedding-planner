/**
 * @canonical scoring_constants -- the North Star weights and accept-rule tolerances.
 *
 * Verbatim from eval-harness/scoring/scoring_model.md. These weights are human-tuned defaults; the
 * loop may NEVER auto-tune them (that is how an optimizer games its own objective — principle 3 of
 * loop-orchestrator/README.md). They live here as the single source of truth for the scorer.
 */

/** planning_value component weights (the numerator). */
export const PLANNING_VALUE_WEIGHTS = {
  quality: 0.4,
  completeness: 0.35,
  guest_experience: 0.25,
} as const

/** couple_cost component weights (the denominator). */
export const COUPLE_COST_WEIGHTS = {
  effort: 0.4,
  money: 0.3,
  stress: 0.3,
} as const

/**
 * Corpus-aggregation weights: adversarial scenarios count at least as much as golden
 * (scoring_model.md condition 4 — "the hard cases are where real improvement shows").
 */
export const AGGREGATION_WEIGHTS = {
  golden: 1,
  adversarial: 2,
} as const

/**
 * Per-capability scorecard inputs: the [0,1] higher-is-better metrics attributed to each capability
 * (a subset of the metric_catalog per-capability table — only the value-metrics whose mean is a
 * meaningful health score, so the scorecard is honest without cost-normalization). The loop targets
 * the weakest capability here. Cost metrics and richer gate attribution are a later refinement.
 */
export const CAPABILITY_VALUE_METRICS: Readonly<Record<string, readonly string[]>> = {
  rsvp: ['rsvp_resolution_rate'],
  guest_qa: ['qa_accuracy_rate'],
  comms_personalization: ['guest_sentiment_score', 'boundary_hold_rate'],
  orchestration: ['autonomy_rate'],
}

/**
 * Anchors for normalizing cost metrics into [0,1] couple_cost components (0 = at/under target, 1 = at
 * worst tolerated). Phase-1 defaults; refined per-couple when richer normalization lands.
 */
export const NORMALIZATION_ANCHORS = {
  /** couple_active_minutes_total at which effort cost reaches 1.0. */
  worst_effort_minutes: 1200,
  /** budget overspend percentage at which money cost reaches 1.0. */
  worst_overspend_pct: 20,
} as const

/**
 * Desired direction of the implemented metrics, for the guard (counter-metric) regression check.
 * higher_better = a drop is a regression; lower_better = a rise is a regression.
 */
export const GUARD_DIRECTIONS: Readonly<Record<string, 'higher_better' | 'lower_better'>> = {
  rsvp_resolution_rate: 'higher_better',
  qa_accuracy_rate: 'higher_better',
  guest_sentiment_score: 'higher_better',
  boundary_hold_rate: 'higher_better',
  autonomy_rate: 'higher_better',
  decision_reversal_rate: 'lower_better',
  couple_active_minutes_total: 'lower_better',
  budget_variance_pct: 'lower_better',
}

/** Tolerances for the accept rule. */
export const ACCEPT_TOLERANCES = {
  /** A golden scenario may not drop more than this in north_star.ratio (condition 1). */
  golden_ratio: 0.02,
  /** A guard counter-metric may not regress more than this (condition 3). */
  guard: 0.02,
  /** Minimum aggregate north_star improvement to count as "improves" (condition 4). */
  aggregate_improvement_epsilon: 1e-9,
} as const
