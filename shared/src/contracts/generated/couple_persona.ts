/* eslint-disable */
/**
 * GENERATED from eval-harness/schemas/couple_persona_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * Seed definition of a simulated couple. An LLM role-player consumes this to act as the couple during an eval run, and graders use the same fields as ground truth when scoring outcomes.
 */
export interface CouplePersona {
/**
 * Stable identifier, e.g. couple_lowbudget_highcount. Referenced by scenarios.
 */
persona_id: string
/**
 * One line: who this couple is and what they are designed to stress.
 */
description: string
wedding_date: {
/**
 * Preferred wedding date (UTC date).
 */
target_date: string
/**
 * How movable the date is. 'fixed' makes the date a hard constraint.
 */
flexibility: ("fixed" | "same_month" | "same_season" | "flexible")
/**
 * Days from planning start to wedding; drives lead-time gap checks.
 */
lead_time_days?: number
}
guest_count_target: {
/**
 * Target headcount.
 */
count: number
/**
 * 'fixed' makes count a hard constraint (venue capacity, catering).
 */
flexibility: ("fixed" | "soft" | "flexible")
}
location: {
/**
 * Home region for vendor sourcing.
 */
region: string
/**
 * How far the couple will travel for venue/vendors.
 */
willing_travel_radius_km: number
/**
 * True if the wedding is intentionally away from home region.
 */
destination_wedding?: boolean
}
budget: {
/**
 * Total budget in cents.
 */
total_budget_cents: number
/**
 * If true, committed spend over total_budget_cents trips BUDGET.CEILING_EXCEEDED.
 */
hard_ceiling: boolean
/**
 * Allowed overshoot when hard_ceiling is false.
 */
flexibility_pct?: number
/**
 * Spend priorities, highest first. The couple will splurge on early items and economize on late ones; drives the quality-per-dollar rubric.
 */
category_priorities: {
category: ("venue" | "catering" | "photography" | "music" | "florals" | "attire" | "invitations" | "decor" | "transport" | "officiant" | "other")
priority: ("splurge" | "standard" | "economize")
/**
 * Optional per-category soft cap.
 */
soft_cap_cents?: number
}[]
}
vision: {
/**
 * Style anchors, e.g. ['rustic','candlelit','wildflowers']. Scored by vision_match_rubric.
 */
aesthetic_keywords: string[]
formality_level: ("casual" | "semi_formal" | "formal" | "black_tie")
/**
 * Non-negotiable wants (not hard constraints, but heavily weighted in vision match).
 */
must_haves: string[]
/**
 * Explicit dislikes; surfacing these is a vision-match penalty.
 */
must_not_haves: string[]
/**
 * Cultural rituals/elements; omission may trip CONSTRAINT.HARD_VIOLATED if also listed in hard_constraints.
 */
cultural_requirements?: string[]
religious_requirements?: string[]
}
/**
 * Sacred constraints that can never be violated. Each maps to a CONSTRAINT.HARD_VIOLATED check.
 */
hard_constraints: {
/**
 * Stable id, e.g. allergy_tree_nut_fatal.
 */
constraint_id: string
type: ("date" | "guest_count" | "budget" | "allergy" | "accessibility" | "cultural" | "religious" | "dietary" | "other")
/**
 * Constraint value; shape depends on type (string, number, or object).
 */
value: {
[k: string]: unknown
}
/**
 * 'fatal' = a violation that could harm a guest (e.g. anaphylaxis).
 */
severity?: ("fatal" | "serious" | "moderate")
description: string
}[]
/**
 * How much the couple wants to decide vs. delegate. Calibrates the autonomy-rate metric and over-automation-regret counter-metric.
 */
decision_style: ("wants_control" | "collaborative" | "delegating")
/**
 * Encodes the propose-confirm default plus any pre-authorized autonomy. See gate_checks.md SPEND.*.
 */
spend_autonomy: {
/**
 * Always propose_confirm by product decision; autonomy is strictly opt-in below.
 */
default_mode: "propose_confirm"
/**
 * Pre-authorized autonomy windows. Empty array = fully propose-confirm.
 */
opted_in_scopes: {
scope_id: string
/**
 * A category (e.g. 'florals') or a specific item id the couple pre-authorized.
 */
applies_to: string
/**
 * Per-commitment cap; over this escalates to confirm even if budget remains.
 */
max_per_item_cents: number
/**
 * If true, only refundable/reversible commitments may auto-execute.
 */
requires_refundable: boolean
/**
 * Autonomy only valid while total committed spend stays within budget.
 */
requires_within_total_budget?: boolean
}[]
}
/**
 * How much of the couple's time the product may consume; denominator of the North Star.
 */
effort_budget: {
max_active_minutes_per_week: number
/**
 * How quickly the couple disengages when overloaded.
 */
tolerance: ("low" | "medium" | "high")
}
/**
 * Instructions for the LLM role-player driving this couple.
 */
simulation_behavior: {
responsiveness: ("prompt" | "average" | "slow" | "erratic")
pickiness: ("easygoing" | "particular" | "very_particular")
/**
 * 'vague'/'contradictory' stress the intent-misread metric.
 */
clarity: ("clear" | "vague" | "contradictory")
/**
 * Free-text steering for the role-player.
 */
notes?: string
}
/**
 * What this persona is designed to stress; informs grader attention and coverage tracking.
 */
expected_pain_points?: string[]
}
