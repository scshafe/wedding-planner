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
 * Phase-8 KEYSTONE — category forge-detection is LOAD-BEARING.
 *
 * `category_completeness_rate` (a third of the `completeness` North-Star component) is scored over the
 * CLAIMED `category.booked` stream: a category is complete iff `booking_status === 'booked'`. Honest
 * booking competence is GENOME-DEPENDENT: an `requires_couple_approval` category is `booked` only by a
 * tier-2 genome (it needs the couple's commitment-authority — the SAME surface Q&A escalation uses); a
 * TIER-1 genome honestly `deferred`s it (completeness < 1). Without a trusted backing a lying planner
 * could CLAIM it booked the approval-required category (or duplicate/suppress) and inflate completeness
 * for free. Phase 8 gives every required category a trusted booking (Stage B) so the gate reconciles it.
 *
 * The corpus (cardinality, doddy P2-A): an approval-FREE category (honest `booked`) AND an approval-
 * REQUIRED category (honest tier-1 `deferred`), so the honest rate is 1/2 — every forge arm has room to
 * strictly raise it. A single immediate guest makes RSVP resolve at every cadence and carries no
 * questions, so qa is null and the ONLY thing the forge can move toward completeness is the category rate.
 * Champion (cadence 1) and candidate (cadence 2) are BOTH TIER-1, so their honest runs are identical
 * (category 0.5 each) and there is no promotion-gate park.
 *
 * Each arm proves the load-bearing fact via a COUNTERFACTUAL (testineer): the forge moves
 * `category_completeness_rate` ABOVE the champion, and `forgeWouldWinAbsentGate` confirms that —
 * recomputing the candidate's aggregate WITHOUT the veto — the forge STRICTLY out-scores the honest
 * champion (a claims-trusting loop would accept it). With the gate it produces a NEW integrity failure and
 * is REJECTED. (A vetoed run zeroes the ratio, which also trips the golden-drop + aggregate conditions, so
 * `accepted=false` alone is over-determined — the counterfactual isolates the gate as the real stopper.)
 * A tier-1 candidate cannot honestly reach a tier-2 champion's completeness either, but that needs a
 * modeled booking-approval couple cost — deferred (consistent with the Q&A-escalation cost); this keystone
 * proves the firewall against the simpler, real inflation: a tier-1 forging completeness it cannot earn.
 */

const BASE_TS = '2027-10-01T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')
const INTEGRITY_CODE = 'INTEGRITY.SELF_REPORT_DIVERGENCE'

const GUEST: GuestPersona = {
  persona_id: 'g_immediate',
  description: 'an immediate responder, no questions',
  relationship: { to_couple: 'friend', side: 'both' },
  contact: { preferred_channel: 'email', preferred_language: 'en' },
  rsvp_truth: { will_attend: 'yes', response_latency: 'immediate' },
  questions: [],
  personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
}

// approval-FREE (honest booked) + approval-REQUIRED (honest tier-1 deferred) ⇒ honest rate 1/2 = 0.5.
const REQUIRED_CATEGORIES = [
  { category_id: 'cat_inv', category: 'invitations', requires_couple_approval: false },
  { category_id: 'cat_venue', category: 'venue', requires_couple_approval: true },
]

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

// Both TIER-1 (no autonomy_threshold). Identical honest behaviour; they differ only in cadence so the
// liar can target the candidate (cadence 2), exactly as the sentiment/Q&A keystones do.
const CHAMPION: StrategyGenome = { genome_id: 'champ', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0 } }
const CANDIDATE: StrategyGenome = { genome_id: 'cand', parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 0 } }

function score(planner: Planner) {
  const runner = makePlannerSimulator({ championGenome: CHAMPION, candidateGenome: CANDIDATE, candidateArtifactRef: genomeArtifactRef(CANDIDATE), baseTimestamp: BASE_TS, planner })
  return scoreCandidateOffline({ corpus: CORPUS, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone8'), harnessVersion: 'h8' })
}

const candValue = (r: ReturnType<typeof score>, code: string): number => r.candidate[0]?.metric_values[code] as number
const baseValue = (r: ReturnType<typeof score>, code: string): number => r.baseline[0]?.metric_values[code] as number
const integrityFailed = (r: ReturnType<typeof score>): boolean => r.decision.new_gate_failures.some((f) => f.includes(INTEGRITY_CODE))
/**
 * Stronger isolation (testineer): INTEGRITY is the SOLE new gate failure — every new failure is an
 * integrity one AND there is at least one. This rules out a second gate masking the over-determination
 * the keystone exists to disprove (a future regression failing some unrelated gate on the forged stream
 * would keep `integrityFailed` true but is caught here).
 */
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

/**
 * The load-bearing COUNTERFACTUAL (testineer): a vetoed run zeroes the ratio, which over-determines
 * `accepted=false`. To prove the INTEGRITY gate is the real stopper, recompute the forged candidate's
 * aggregate WITHOUT the veto (vetoed=false) and confirm it strictly beats the honest champion — i.e.
 * absent the gate, the forge WOULD be accepted.
 */
function forgeWouldWinAbsentGate(r: ReturnType<typeof score>): boolean {
  return aggregateRatio(r.candidate, false) > aggregateRatio(r.baseline, false)
}

const isCategory = (e: EventEnvelope, categoryId: string): boolean =>
  e.event_name === EVENT_NAMES.category_booked && (e.payload as { category_id: string }).category_id === categoryId

// A liar that lies ONLY for the candidate (cadence 2); the champion (cadence 1) stays honest.
function liar(mutate: (events: EventEnvelope[]) => EventEnvelope[]): Planner {
  return (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.parameters.rsvp_reminder_cadence !== 2) return honest
    return mutate(honest)
  }
}

describe('keystone — CLAIMING a booking of an approval-required category does not pay (the tier-1 category forge)', () => {
  it('claims booking_status=booked (tier-2-grade booking it cannot do): completeness up vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) =>
        events.map((e) =>
          isCategory(e, 'cat_venue')
            ? { ...e, payload: { ...(e.payload as Record<string, unknown>), booking_status: 'booked' } }
            : e,
        ),
      ),
    )
    expect(candValue(r, METRIC_CODES.category_completeness_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.category_completeness_rate)) // RED: 1.0 > 0.5
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the forge STRICTLY out-scores the champion...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: claimed booked ≠ trusted deferred → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — DUPLICATING a booked category does not pay (diluting the deferred one)', () => {
  it('re-emits the approval-free booked claim to dilute the deferred: completeness up vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) => {
        const dup = events.find((e) => isCategory(e, 'cat_inv'))
        return dup === undefined ? events : [...events, dup]
      }),
    )
    expect(candValue(r, METRIC_CODES.category_completeness_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.category_completeness_rate)) // RED: 2/3 > 1/2
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the forge wins...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: a 2nd booking for an already-claimed category → forged
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — SUPPRESSING the deferred category does not pay (claims-only denominator)', () => {
  it('omits the deferred category (drops a 0 from the rate): completeness up vs champion, but VETOED + rejected', () => {
    const r = score(liar((events) => events.filter((e) => !isCategory(e, 'cat_venue'))))
    expect(candValue(r, METRIC_CODES.category_completeness_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.category_completeness_rate)) // RED: 1/1 > 1/2
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the forge wins...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: a trusted category with no claim → suppressed_effect
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — the HONEST candidate is gate-CLEAN (the veto targets the lie, not the model)', () => {
  it('honest category claims match the trusted record; the candidate ties the champion and does not win', () => {
    const r = score(rsvpCadencePlanner)
    expect(integrityFailed(r)).toBe(false) // honest claims (inv booked, venue deferred) match trusted
    expect(r.decision.new_gate_failures).toEqual([]) // positively: the honest candidate trips NO new gate
    expect(candValue(r, METRIC_CODES.category_completeness_rate)).toBe(baseValue(r, METRIC_CODES.category_completeness_rate)) // both 0.5
    expect(r.decision.accepted).toBe(false) // a tie does not improve the aggregate — no honest win to forge over
  })
})
