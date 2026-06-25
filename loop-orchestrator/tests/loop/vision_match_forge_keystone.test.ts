import {
  AGGREGATION_WEIGHTS,
  computeNorthStar,
  deriveNorthStarInputs,
  guardSpecsFor,
  loadCouplePersona,
  makePlannerSimulator,
  type Planner,
  rsvpCadencePlanner,
  scoreCandidateOffline,
  type ScenarioDefinition,
} from '@wedding-planner/eval-harness'
import {
  type EventEnvelope,
  genomeArtifactRef,
  type GuestPersona,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Phase-10 KEYSTONE — vision_match forge-detection is LOAD-BEARING (the `quality` capstone).
 *
 * `vision_match_rate` is the only `planning_value.quality` rubric backed offline; `quality` is the largest
 * (0.40) numerator component, computed for the FIRST time here. Honest alignment is GENOME-DEPENDENT: a
 * vision-sensitive booked category is ALIGNED (1.0) only by a genome that can CONSULT the couple (tier-2,
 * paying a `vision_consult` couple session — the SAME commitment-authority surface category/Q&A escalation
 * uses); a TIER-1 genome books a DEFAULT (0.5) selection. Two forges, each isolated to a SINGLE mover:
 *
 *  - VALUE forge (tier-1 vs tier-1): both honestly score 0.5; the candidate CLAIMS the aligned 1.0 it cannot
 *    earn → vision_match_rate ↑ → quality ↑ → ratio ↑. The new `vision_alignment` reconciliation field-diffs
 *    the claimed 1.0 against the trusted 0.5 → veto.
 *  - COST forge (tier-2 vs tier-2): both align (1.0, identical completeness AND quality); the candidate
 *    SHAVES then SUPPRESSES its `vision_consult` couple session → couple_active_minutes_total ↓ →
 *    effort_cost ↓ → ratio ↑. Phase 9's couple-session reconciliation field-diffs/suppression-checks it → veto.
 *
 * The corpus is PINNED (Step-0 P0/P1): a SINGLE approval-free, vision-sensitive category + a SINGLE
 * immediate-responder guest (not couple-resolvable, no questions). So the category is booked at any tier
 * (completeness held), the immediate guest resolves at every cadence with no nags (rsvp + sentiment held),
 * and at tier-2 the ONLY couple session is the vision_consult one — making `vision_match` the sole VALUE
 * mover and `vision_consult` the provably-sole COST mover. Champion (cadence 1) and candidate (cadence 2)
 * are SAME-tier (no promotion-gate park) and behave identically when honest, so the liar can target the
 * candidate exactly as the category/Q&A/sentiment keystones do. Each arm proves the load-bearing fact via
 * the COUNTERFACTUAL `forgeWouldWinAbsentGate` (absent the veto the forge STRICTLY out-scores the honest
 * champion → a claims-trusting loop would accept it) and `onlyIntegrityFailed` (INTEGRITY is the SOLE new
 * gate failure, ruling out an over-determined `accepted=false`). Asserts are DIRECTION + GATE, never the
 * magnitude of the ratio delta (the 0.40 quality weight rides this single rubric while thin).
 */

const BASE_TS = '2027-11-01T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')
const INTEGRITY_CODE = 'INTEGRITY.SELF_REPORT_DIVERGENCE'

const GUEST: GuestPersona = {
  persona_id: 'g_immediate',
  description: 'an immediate responder, no questions, not couple-resolvable',
  relationship: { to_couple: 'friend', side: 'both' },
  contact: { preferred_channel: 'email', preferred_language: 'en' },
  rsvp_truth: { will_attend: 'yes', response_latency: 'immediate' },
  questions: [],
  personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
}

// A SINGLE approval-free (booked at any tier → completeness held) vision-sensitive category. Vision is the
// only tier-dependent axis: honest 0.5 at tier-1, 1.0 + a vision_consult session at tier-2.
const VISION_CATEGORY = [{ category_id: 'cat_decor', category: 'decor', requires_couple_approval: false, vision_sensitive: true }]

function scenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
  return {
    scenario_id: id,
    scenario_type: type,
    couple: COUPLE,
    guests: [GUEST],
    bookedPlanFacts: {},
    targetMetrics: [{ metric_code: 'vision_match_rate', direction: 'gte', threshold: 0.3 }],
    required_categories: VISION_CATEGORY,
  }
}
const CORPUS: readonly ScenarioDefinition[] = [scenario('golden_g', 'golden'), scenario('adv_a', 'adversarial')]

const TIER1_CHAMP: StrategyGenome = { genome_id: 'champ1', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0 } }
const TIER1_CAND: StrategyGenome = { genome_id: 'cand1', parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 0 } }
const TIER2_CHAMP: StrategyGenome = { genome_id: 'champ2', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0, autonomy_threshold: 1 } }
const TIER2_CAND: StrategyGenome = { genome_id: 'cand2', parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 0, autonomy_threshold: 1 } }

function score(planner: Planner, champion: StrategyGenome, candidate: StrategyGenome) {
  const runner = makePlannerSimulator({ championGenome: champion, candidateGenome: candidate, candidateArtifactRef: genomeArtifactRef(candidate), baseTimestamp: BASE_TS, planner })
  return scoreCandidateOffline({ corpus: CORPUS, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone10'), harnessVersion: 'h10' })
}

type Result = ReturnType<typeof score>
const candValue = (r: Result, code: string): number | null => r.candidate[0]?.metric_values[code] ?? null
const baseValue = (r: Result, code: string): number | null => r.baseline[0]?.metric_values[code] ?? null
const integrityFailed = (r: Result): boolean => r.decision.new_gate_failures.some((f) => f.includes(INTEGRITY_CODE))
const onlyIntegrityFailed = (r: Result): boolean =>
  r.decision.new_gate_failures.length > 0 && r.decision.new_gate_failures.every((f) => f.includes(INTEGRITY_CODE))

/** Corpus-aggregate North Star, recomputed from per-scenario metric_values with veto-zeroing CHOSEN. */
function aggregateRatio(scores: Result['candidate'], vetoed: boolean): number {
  let weighted = 0
  let totalWeight = 0
  for (let i = 0; i < scores.length; i += 1) {
    const s = scores[i]
    const scn = CORPUS[i]
    if (s === undefined || scn === undefined) continue
    const ratio = computeNorthStar(deriveNorthStarInputs(s.metric_values, scn.couple), vetoed).ratio
    const weight = AGGREGATION_WEIGHTS[scn.scenario_type as keyof typeof AGGREGATION_WEIGHTS] ?? 1
    weighted += weight * ratio
    totalWeight += weight
  }
  return weighted / totalWeight
}

/** Absent the veto, does the forged candidate strictly out-score the honest champion? (the load-bearing CF) */
function forgeWouldWinAbsentGate(r: Result): boolean {
  return aggregateRatio(r.candidate, false) > aggregateRatio(r.baseline, false)
}

const isVision = (e: EventEnvelope, categoryId: string): boolean =>
  e.event_name === EVENT_NAMES.category_vision_aligned && (e.payload as { category_id: string }).category_id === categoryId
const isVisionConsult = (e: EventEnvelope, categoryId: string): boolean =>
  e.event_name === EVENT_NAMES.couple_session_ended &&
  (e.payload as { session_reason?: string }).session_reason === 'vision_consult' &&
  (e.payload as { about_id?: string }).about_id === categoryId

/** A liar that lies ONLY for the candidate (cadence 2); the champion (cadence 1) stays honest. */
function liar(mutate: (events: EventEnvelope[]) => EventEnvelope[]): Planner {
  return (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.parameters.rsvp_reminder_cadence !== 2) return honest
    return mutate(honest)
  }
}

describe('keystone — the VALUE forge: CLAIMING an aligned 1.0 a tier-1 genome cannot earn', () => {
  it('claims vision_match_score=1.0 (consulted-grade it cannot do): quality up vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) =>
        events.map((e) =>
          isVision(e, 'cat_decor')
            ? { ...e, payload: { ...(e.payload as Record<string, unknown>), vision_match_score: 1 } }
            : e,
        ),
      ),
      TIER1_CHAMP,
      TIER1_CAND,
    )
    expect(candValue(r, METRIC_CODES.vision_match_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.vision_match_rate) as number) // RED: 1.0 > 0.5
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the forge STRICTLY out-scores the champion...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: claimed 1.0 ≠ trusted 0.5 → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — the COST forge: aligning honestly but SHAVING/SUPPRESSING the vision_consult cost', () => {
  it('the honest tier-2 companion pays EXACTLY one vision_consult session (10 min) — vision_consult is the sole cost mover', () => {
    const r = score(rsvpCadencePlanner, TIER2_CHAMP, TIER2_CAND)
    expect(baseValue(r, METRIC_CODES.couple_active_minutes_total)).toBe(10) // one 600s session ÷ 60
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total)).toBe(10)
  })

  it('SHAVES the vision_consult active_seconds (599 vs 600): cost down vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) =>
        events.map((e) =>
          isVisionConsult(e, 'cat_decor')
            ? { ...e, payload: { ...(e.payload as Record<string, unknown>), active_seconds: 599 } }
            : e,
        ),
      ),
      TIER2_CHAMP,
      TIER2_CAND,
    )
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total) as number).toBeLessThan(baseValue(r, METRIC_CODES.couple_active_minutes_total) as number) // RED: cost shaved
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the lower cost wins...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: claimed 599 ≠ trusted 600 → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })

  it('SUPPRESSES the vision_consult session entirely: cost down vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) => events.filter((e) => !isVisionConsult(e, 'cat_decor'))),
      TIER2_CHAMP,
      TIER2_CAND,
    )
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total) as number).toBeLessThan(baseValue(r, METRIC_CODES.couple_active_minutes_total) as number) // RED: cost dropped to 0
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the lower cost wins...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: a trusted vision_consult session with no claim → suppressed_effect
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — the HONEST candidate is gate-CLEAN (the veto targets the lie, not the model)', () => {
  it('tier-1: honest vision claims match the trusted 0.5; the candidate ties the champion and does not win', () => {
    const r = score(rsvpCadencePlanner, TIER1_CHAMP, TIER1_CAND)
    expect(integrityFailed(r)).toBe(false)
    expect(r.decision.new_gate_failures).toEqual([]) // positively: the honest candidate trips NO new gate
    expect(candValue(r, METRIC_CODES.vision_match_rate)).toBe(baseValue(r, METRIC_CODES.vision_match_rate)) // both 0.5
    expect(r.decision.accepted).toBe(false) // a tie does not improve the aggregate — no honest win to forge over
  })

  it('tier-2: honest alignment (1.0) + vision_consult cost match the trusted record; candidate ties, not accepted', () => {
    const r = score(rsvpCadencePlanner, TIER2_CHAMP, TIER2_CAND)
    expect(r.decision.new_gate_failures).toEqual([])
    expect(candValue(r, METRIC_CODES.vision_match_rate)).toBe(1)
    expect(r.decision.accepted).toBe(false)
  })
})
