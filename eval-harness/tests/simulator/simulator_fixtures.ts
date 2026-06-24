import {
  genomeArtifactRef,
  type GuestPersona,
  type StrategyGenome,
} from '@wedding-planner/shared'

import { loadCouplePersona, type ScenarioDefinition } from '@wedding-planner/eval-harness'

/**
 * Shared fixtures for the planner-simulator tests: real-ish guest personas carrying the ground-truth
 * `rsvp_truth` the Stage-A planner reads, plus genome + scenario builders. Kept deterministic and
 * minimal — guests differ only in the fields that drive the rsvp model.
 */

type Latency = GuestPersona['rsvp_truth']['response_latency']
type WillAttend = GuestPersona['rsvp_truth']['will_attend']

/** Build a schema-shaped guest persona whose RSVP behavior is fixed by latency + intent. The optional
 *  `coupleResolvable` sets the Phase-4b ground-truth fact: the couple can resolve this guest on escalation. */
export function makeGuest(
  personaId: string,
  latency: Latency,
  willAttend: WillAttend = 'yes',
  coupleResolvable?: boolean,
): GuestPersona {
  return {
    persona_id: personaId,
    description: `Test guest ${personaId} (${latency}).`,
    relationship: { to_couple: 'friend', side: 'both' },
    contact: { preferred_channel: 'email', preferred_language: 'en' },
    rsvp_truth: {
      will_attend: willAttend,
      response_latency: latency,
      ...(coupleResolvable === undefined ? {} : { couple_resolvable: coupleResolvable }),
    },
    questions: [],
    personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
  }
}

/** A genome at a given (rsvp_reminder_cadence, reminder_spacing, reminder_batching). Spacing/batching
 *  default to 0 (tightly packed, no consolidation) — the behavior-identical Phase-3 form. */
export function makeGenome(
  cadence: number,
  spacing = 0,
  batching = 0,
  genomeId = `g_c${cadence}_s${spacing}_b${batching}`,
): StrategyGenome {
  return {
    genome_id: genomeId,
    parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: spacing, reminder_batching: batching },
  }
}

/** A TIER-2 genome carrying the escalate-to-couple knob `autonomy_threshold` (Phase 4b; derives tier 2). */
export function makeTier2Genome(
  cadence: number,
  spacing: number,
  autonomyThreshold: number,
  batching = 0,
  genomeId = `g_c${cadence}_s${spacing}_b${batching}_a${autonomyThreshold}`,
): StrategyGenome {
  return {
    genome_id: genomeId,
    parameters: {
      rsvp_reminder_cadence: cadence,
      reminder_spacing: spacing,
      reminder_batching: batching,
      autonomy_threshold: autonomyThreshold,
    },
  }
}

/** The content-addressed artifact_ref a candidate carrying this genome must commit to. */
export function refFor(genome: StrategyGenome): string {
  return genomeArtifactRef(genome)
}

const COUPLE = loadCouplePersona('couple_standard_baseline')

/** A scenario with a configurable guest list (default: a mix spanning the latency spectrum). */
export function makeScenario(
  scenarioId: string,
  guests: readonly GuestPersona[] = DEFAULT_GUESTS,
  scenarioType: ScenarioDefinition['scenario_type'] = 'golden',
): ScenarioDefinition {
  return {
    scenario_id: scenarioId,
    scenario_type: scenarioType,
    couple: COUPLE,
    guests,
    bookedPlanFacts: {},
    targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.5 }],
  }
}

/**
 * A guest mix that makes the genome→metric relationship visible: one immediate responder, one that
 * needs a single reminder, one that needs multiple, and one that never responds. Raising cadence
 * resolves more of them (resolution up) while nagging the slow/never guests (sentiment down).
 */
export const DEFAULT_GUESTS: readonly GuestPersona[] = [
  makeGuest('guest_immediate', 'immediate', 'yes'),
  makeGuest('guest_one_nudge', 'after_one_reminder', 'yes'),
  makeGuest('guest_many_nudges', 'after_multiple_reminders', 'no'),
  makeGuest('guest_never', 'never', 'maybe_needs_nudge'),
]
