import { loadCouplePersona, type ScenarioDefinition } from '@wedding-planner/eval-harness'
import { type GuestPersona } from '@wedding-planner/shared'

/**
 * Phase 11 — the ADVISORY plan-side corpus: vision-sensitive scenarios over which the advisory pass
 * explores tier-2 candidates (consulting the couple to align a booked category). It is SEPARATE from the
 * tier-1 search corpus (`rsvp_corpus.ts`) and is NEVER added to it — these scenarios carry
 * `required_categories` / `vision_sensitive`, runtime-only `ScenarioDefinition` fields absent from
 * `scenario_schema.json`, so they are keystone/advisory-only by construction. Reuses the Phase-10 vision
 * keystone shape: a single approval-free, vision-sensitive category + a single immediate-responder guest,
 * so the category books at any tier (completeness held), the guest resolves with no nags (rsvp/sentiment
 * held), and vision alignment is the only tier-dependent value axis — a tier-2 genome that consults
 * aligns at 1.0 (paying a vision_consult couple session); a tier-1 genome defaults at 0.5.
 */

const COUPLE = loadCouplePersona('couple_standard_baseline')

const IMMEDIATE_GUEST: GuestPersona = {
  persona_id: 'g_immediate',
  description: 'an immediate responder, no questions, not couple-resolvable',
  relationship: { to_couple: 'friend', side: 'both' },
  contact: { preferred_channel: 'email', preferred_language: 'en' },
  rsvp_truth: { will_attend: 'yes', response_latency: 'immediate' },
  questions: [],
  personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
}

/** A single approval-free, vision-sensitive category: booked at any tier; vision is the only tier-dependent axis. */
const VISION_CATEGORY = [
  { category_id: 'cat_decor', category: 'decor', requires_couple_approval: false, vision_sensitive: true },
]

function visionScenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
  return {
    scenario_id: id,
    scenario_type: type,
    couple: COUPLE,
    guests: [IMMEDIATE_GUEST],
    bookedPlanFacts: {},
    targetMetrics: [{ metric_code: 'vision_match_rate', direction: 'gte', threshold: 0.3 }],
    required_categories: VISION_CATEGORY,
  }
}

/** The advisory corpus: one golden + one adversarial vision-sensitive scenario. */
export const ADVISORY_CORPUS: readonly ScenarioDefinition[] = [
  visionScenario('advisory_vision_golden', 'golden'),
  visionScenario('advisory_vision_adversarial', 'adversarial'),
]

/**
 * The advisory guard set (positive rule, architect P2): the value metrics present in the advisory corpus,
 * MINUS `couple_active_minutes_total`. Excluding the cost is required (it is already priced into the
 * North-Star denominator; guarding it double-counts and rejects every tier-2 candidate). Guarding the
 * value metrics closes the cross-value-regression hole.
 */
export const ADVISORY_GUARD_METRICS: readonly string[] = ['rsvp_resolution_rate', 'vision_match_rate']
