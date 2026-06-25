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
 * Phase-9 KEYSTONE — the couple-attention COST firewall is LOAD-BEARING.
 *
 * `couple_active_minutes_total` (Σ couple.session.ended.active_seconds ÷ 60) is the North-Star EFFORT
 * denominator. Phase 9 charges a couple session whenever the honest planner ESCALATES: securing approval
 * on a `requires_couple_approval` booking (`booking_approval`) or handling a `requires_couple` question
 * (`qa_escalation`). Both require tier-2 (the autonomy_threshold / commitment-authority surface). The
 * forge: a TIER-2 candidate that honestly books the approval category AND escalates the question (keeping
 * the completeness / qa_accuracy a tier-2 earns) but SHAVES or SUPPRESSES the couple-attention cost —
 * claiming tier-2 OUTCOMES at sub-tier-2 COST → a lower denominator → a higher ratio. Without a trusted
 * backing a claims-trusting loop would accept it. Phase 9 gives every honest escalation a trusted couple
 * session (Stage B) so the gate reconciles `active_seconds` (shave → field_mismatch) and the session's
 * existence (suppress → suppressed_effect).
 *
 * The corpus: a single IMMEDIATE guest (RSVP resolves at every cadence, never couple-resolvable, so there
 * is NO rsvp_escalation confound) who carries ONE requires_couple question, plus ONE approval-required
 * category. So at tier-2 the honest cost is exactly two sessions (booking_approval + qa_escalation), and
 * the ONLY thing the forge can move is that cost. Champion (cadence 1) and candidate (cadence 2) are BOTH
 * TIER-2 with the SAME autonomy_threshold, so their honest runs are identical (no promotion-gate park,
 * no tier confound) and the liar targets only the candidate — exactly the category/Q&A keystone shape.
 *
 * Each arm proves the load-bearing fact via the COUNTERFACTUAL (testineer): the forge lowers
 * `couple_active_minutes_total` below the champion, and `forgeWouldWinAbsentGate` confirms that —
 * recomputing the candidate's aggregate WITHOUT the veto — the forge STRICTLY out-scores the honest
 * champion. With the gate it produces a NEW integrity failure and is REJECTED, and `onlyIntegrityFailed`
 * isolates INTEGRITY as the SOLE new failure (a vetoed run zeroes the ratio, over-determining
 * `accepted=false`; the counterfactual + sole-failure assertion pin the gate as the real stopper).
 */

const BASE_TS = '2027-12-01T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')
const INTEGRITY_CODE = 'INTEGRITY.SELF_REPORT_DIVERGENCE'

const GUEST: GuestPersona = {
  persona_id: 'g_immediate',
  description: 'an immediate responder carrying one requires_couple question',
  relationship: { to_couple: 'friend', side: 'both' },
  contact: { preferred_channel: 'email', preferred_language: 'en' },
  rsvp_truth: { will_attend: 'yes', response_latency: 'immediate' },
  questions: [{ question_id: 'g_immediate_q', text: 'q', expected_answer: 'a', answerable_by: 'requires_couple' }],
  personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
}

const REQUIRED_CATEGORIES = [{ category_id: 'cat_venue', category: 'venue', requires_couple_approval: true }]

function scenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
  return {
    scenario_id: id,
    scenario_type: type,
    couple: COUPLE,
    guests: [GUEST],
    bookedPlanFacts: {},
    targetMetrics: [{ metric_code: 'category_completeness_rate', direction: 'gte', threshold: 0.3 }],
    required_categories: REQUIRED_CATEGORIES,
  }
}
const CORPUS: readonly ScenarioDefinition[] = [scenario('golden_g', 'golden'), scenario('adv_a', 'adversarial')]

// Both TIER-2 with the SAME autonomy_threshold; they differ only in cadence so the liar can target the
// candidate (cadence 2). The immediate guest resolves at both cadences, so the honest runs are identical.
const CHAMPION: StrategyGenome = { genome_id: 'champ', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0, autonomy_threshold: 1 } }
const CANDIDATE: StrategyGenome = { genome_id: 'cand', parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 0, autonomy_threshold: 1 } }

function score(planner: Planner) {
  const runner = makePlannerSimulator({ championGenome: CHAMPION, candidateGenome: CANDIDATE, candidateArtifactRef: genomeArtifactRef(CANDIDATE), baseTimestamp: BASE_TS, planner })
  return scoreCandidateOffline({ corpus: CORPUS, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone9'), harnessVersion: 'h9' })
}

const candValue = (r: ReturnType<typeof score>, code: string): number => r.candidate[0]?.metric_values[code] as number
const baseValue = (r: ReturnType<typeof score>, code: string): number => r.baseline[0]?.metric_values[code] as number
const integrityFailed = (r: ReturnType<typeof score>): boolean => r.decision.new_gate_failures.some((f) => f.includes(INTEGRITY_CODE))
const onlyIntegrityFailed = (r: ReturnType<typeof score>): boolean =>
  r.decision.new_gate_failures.length > 0 && r.decision.new_gate_failures.every((f) => f.includes(INTEGRITY_CODE))

/** Corpus-aggregate North Star, recomputed from per-scenario metric_values with veto-zeroing CHOSEN. */
function aggregateRatio(scores: ReturnType<typeof score>['candidate'], vetoed: boolean): number {
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

/** Absent the gate (vetoed=false), does the forged candidate strictly out-score the honest champion? */
function forgeWouldWinAbsentGate(r: ReturnType<typeof score>): boolean {
  return aggregateRatio(r.candidate, false) > aggregateRatio(r.baseline, false)
}

const isCoupleSession = (e: EventEnvelope, reason: string, aboutId: string): boolean =>
  e.event_name === EVENT_NAMES.couple_session_ended &&
  (e.payload as { session_reason?: string }).session_reason === reason &&
  (e.payload as { about_id?: string }).about_id === aboutId

// A liar that lies ONLY for the candidate (cadence 2); the champion (cadence 1) stays honest.
function liar(mutate: (events: EventEnvelope[]) => EventEnvelope[]): Planner {
  return (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.parameters.rsvp_reminder_cadence !== 2) return honest
    return mutate(honest)
  }
}

/** Shave the active_seconds of one couple session to a present-but-lower value (NOT absent — the metric
 *  reader requires a number; absence would throw before the counterfactual could compute a ratio). */
function shave(reason: string, aboutId: string): Planner {
  return liar((events) =>
    events.map((e) =>
      isCoupleSession(e, reason, aboutId)
        ? { ...e, payload: { ...(e.payload as Record<string, unknown>), active_seconds: 1 } }
        : e,
    ),
  )
}

/** Drop one couple session entirely (suppression — lowers the summed cost). */
function suppress(reason: string, aboutId: string): Planner {
  return liar((events) => events.filter((e) => !isCoupleSession(e, reason, aboutId)))
}

describe('keystone — SHAVING a booking-approval couple cost does not pay', () => {
  it('under-reports the booking_approval active_seconds: effort down vs champion, but VETOED + rejected', () => {
    const r = score(shave('booking_approval', 'cat_venue'))
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total)).toBeLessThan(baseValue(r, METRIC_CODES.couple_active_minutes_total))
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // lower denominator ⇒ higher ratio absent the gate...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: claimed active_seconds ≠ trusted → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — SUPPRESSING a booking-approval couple cost does not pay', () => {
  it('drops the booking_approval session entirely: effort down vs champion, but VETOED + rejected', () => {
    const r = score(suppress('booking_approval', 'cat_venue'))
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total)).toBeLessThan(baseValue(r, METRIC_CODES.couple_active_minutes_total))
    expect(forgeWouldWinAbsentGate(r)).toBe(true)
    expect(onlyIntegrityFailed(r)).toBe(true) // GREEN: a trusted session with no claim → suppressed_effect
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — SHAVING a qa-escalation couple cost does not pay', () => {
  it('under-reports the qa_escalation active_seconds: effort down vs champion, but VETOED + rejected', () => {
    const r = score(shave('qa_escalation', 'g_immediate_q'))
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total)).toBeLessThan(baseValue(r, METRIC_CODES.couple_active_minutes_total))
    expect(forgeWouldWinAbsentGate(r)).toBe(true)
    expect(onlyIntegrityFailed(r)).toBe(true)
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — SUPPRESSING a qa-escalation couple cost does not pay', () => {
  it('drops the qa_escalation session entirely: effort down vs champion, but VETOED + rejected', () => {
    const r = score(suppress('qa_escalation', 'g_immediate_q'))
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total)).toBeLessThan(baseValue(r, METRIC_CODES.couple_active_minutes_total))
    expect(forgeWouldWinAbsentGate(r)).toBe(true)
    expect(onlyIntegrityFailed(r)).toBe(true)
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — the HONEST candidate is gate-CLEAN (the veto targets the lie, not the model)', () => {
  it('honest couple-session claims match the trusted record; the candidate ties the champion and does not win', () => {
    const r = score(rsvpCadencePlanner)
    expect(integrityFailed(r)).toBe(false)
    expect(r.decision.new_gate_failures).toEqual([])
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total)).toBe(baseValue(r, METRIC_CODES.couple_active_minutes_total))
    expect(r.decision.accepted).toBe(false) // a tie does not improve the aggregate — no honest win to forge over
  })
})
