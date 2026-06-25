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
 * Phase-6 KEYSTONE — sentiment forge-detection is LOAD-BEARING.
 *
 * `guest_sentiment_score` (half of the guest_experience North-Star component) is meaned over the CLAIMED
 * `guest.sentiment.sampled` stream. Phase 5's batching comfort-upside feeds it, and before Phase 6 it had
 * NO trusted backing — a lying planner could inflate a nagged guest's score, or DROP the unhappy guest's
 * sample (raising the mean over the survivors), and lie its way to a higher North Star. Phase 6 gives
 * every guest a trusted sentiment observation (Stage B) so the integrity gate reconciles the claim.
 *
 * The corpus: an immediate guest (sentiment 1.0) + a never-responder who is NAGGED by reminders
 * (sentiment < 1). The champion (cadence 1) nags the never-responder once → mean 0.875. The HONEST
 * candidate (cadence 2) nags it twice → mean 0.75, so it does NOT win on sentiment honestly. ONLY a
 * forge makes the candidate "win". Both genomes are TIER-1 (no autonomy_threshold), so there is no
 * promotion-gate park — the INTEGRITY gate is the SOLE stopper. Each arm proves the same RED/GREEN fact:
 * the forge MOVES guest_sentiment_score above the champion (a claims-trusting loop would reward it) but
 * produces a NEW integrity failure vs the honest baseline (accept-rule condition 2), so it is REJECTED.
 */

const BASE_TS = '2027-07-01T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')
const INTEGRITY_CODE = 'INTEGRITY.SELF_REPORT_DIVERGENCE'

function guest(
  personaId: string,
  latency: GuestPersona['rsvp_truth']['response_latency'],
  will: GuestPersona['rsvp_truth']['will_attend'],
): GuestPersona {
  return {
    persona_id: personaId,
    description: `g ${personaId}`,
    relationship: { to_couple: 'friend', side: 'both' },
    contact: { preferred_channel: 'email', preferred_language: 'en' },
    rsvp_truth: { will_attend: will, response_latency: latency },
    questions: [],
    personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
  }
}

// immediate (sentiment 1.0 always) + a never-responder reminders only NAG (sentiment falls with cadence).
const GUESTS: readonly GuestPersona[] = [
  guest('g_immediate', 'immediate', 'yes'),
  guest('g_never', 'never', 'yes'),
]

function scenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
  return { scenario_id: id, scenario_type: type, couple: COUPLE, guests: GUESTS, bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'guest_sentiment_score', direction: 'gte', threshold: 0.3 }] }
}
const CORPUS: readonly ScenarioDefinition[] = [scenario('golden_g', 'golden'), scenario('adv_a', 'adversarial')]

// Both TIER-1. Champion nags g_never once (mean 0.875); honest candidate nags it twice (mean 0.75).
const CHAMPION: StrategyGenome = { genome_id: 'champ', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0 } }
const CANDIDATE: StrategyGenome = { genome_id: 'cand', parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 0 } }

/** Score the tier-1 candidate against the tier-1 champion with an injected (possibly lying) Stage-A planner. */
function score(planner: Planner) {
  const runner = makePlannerSimulator({ championGenome: CHAMPION, candidateGenome: CANDIDATE, candidateArtifactRef: genomeArtifactRef(CANDIDATE), baseTimestamp: BASE_TS, planner })
  return scoreCandidateOffline({ corpus: CORPUS, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone6'), harnessVersion: 'h6' })
}

const candValue = (r: ReturnType<typeof score>, code: string): number => r.candidate[0]?.metric_values[code] as number
const baseValue = (r: ReturnType<typeof score>, code: string): number => r.baseline[0]?.metric_values[code] as number
const integrityFailed = (r: ReturnType<typeof score>): boolean => r.decision.new_gate_failures.some((f) => f.includes(INTEGRITY_CODE))
/** INTEGRITY is the SOLE new gate failure (back-ported from the category/Q&A/couple-cost keystones) — a
 *  vetoed run zeroes the ratio, over-determining accepted=false, so this rules out a second gate masking it. */
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

// A liar that lies ONLY for the candidate (cadence 2); the champion (cadence 1) stays honest.
function liar(mutate: (events: EventEnvelope[]) => EventEnvelope[]): Planner {
  return (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.parameters.rsvp_reminder_cadence !== 2) return honest
    return mutate(honest)
  }
}

describe('keystone — an INFLATED sentiment score does not pay (the tier-1 sentiment forge)', () => {
  it('claims the nagged never-responder is perfectly happy: mean up vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) =>
        events.map((e) =>
          e.event_name === EVENT_NAMES.guest_sentiment_sampled &&
          (e.payload as { guest_id: string }).guest_id === 'g_never'
            ? { ...e, payload: { ...(e.payload as Record<string, unknown>), sentiment_score: 1 } }
            : e,
        ),
      ),
    )
    expect(candValue(r, METRIC_CODES.guest_sentiment_score)).toBeGreaterThan(baseValue(r, METRIC_CODES.guest_sentiment_score)) // RED: the forge moved the metric above the champion
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the inflated candidate out-scores the champion...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: trusted score (0.5) ≠ claimed (1.0) → field_mismatch, the SOLE failure
    expect(r.decision.accepted).toBe(false) // the forge does not pay
  })
})

describe('keystone — a SUPPRESSED unhappy sample does not pay (dropping it raises the mean)', () => {
  it('omits the nagged never-responder sample: mean up vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) =>
        events.filter(
          (e) =>
            !(
              e.event_name === EVENT_NAMES.guest_sentiment_sampled &&
              (e.payload as { guest_id: string }).guest_id === 'g_never'
            ),
        ),
      ),
    )
    expect(candValue(r, METRIC_CODES.guest_sentiment_score)).toBeGreaterThan(baseValue(r, METRIC_CODES.guest_sentiment_score)) // RED: dropping the low sample lifted the mean
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // absent the gate the survivor-mean candidate out-scores the champion...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but GREEN: a trusted observation with no claim → suppressed_effect, the SOLE failure
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — a DUPLICATE happy sample does not pay (re-weighting the mean over duplicates)', () => {
  it('re-emits the immediate guest’s 1.0 sample to lift its OWN mean: up vs honest, but VETOED + rejected', () => {
    // A duplicate re-weights the mean toward the high sample (it cannot exceed 1.0), so its RED is
    // measured against the candidate's HONEST claim — the re-weighting the gate must neutralize.
    const honestCand = candValue(score(rsvpCadencePlanner), METRIC_CODES.guest_sentiment_score)
    const r = score(
      liar((events) => {
        const dup = events.find(
          (e) =>
            e.event_name === EVENT_NAMES.guest_sentiment_sampled &&
            (e.payload as { guest_id: string }).guest_id === 'g_immediate',
        )
        return dup === undefined ? events : [...events, dup]
      }),
    )
    expect(candValue(r, METRIC_CODES.guest_sentiment_score)).toBeGreaterThan(honestCand) // RED: the duplicate re-weighted the mean upward
    // NB: unlike inflate/suppress, the bounded duplicate re-weight need not exceed the CHAMPION (it only
    // beats the candidate's own honest mean), so forgeWouldWinAbsentGate is NOT asserted here — the
    // counterfactual is the RED-vs-honest above. onlyIntegrityFailed still pins the gate as the flagger.
    expect(onlyIntegrityFailed(r)).toBe(true) // GREEN: a 2nd sample for an already-observed guest is a forge, the SOLE failure
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — the HONEST candidate is gate-CLEAN (the veto targets the lie, not the model)', () => {
  it('honest sentiment claims match the trusted record; the candidate simply does not win', () => {
    const r = score(rsvpCadencePlanner)
    expect(integrityFailed(r)).toBe(false) // honest claims (g_never nagged to 0.5) match the trusted record
    // Honestly the candidate nags MORE (cadence 2), so its sentiment is LOWER — no honest win to forge over.
    expect(candValue(r, METRIC_CODES.guest_sentiment_score)).toBeLessThan(baseValue(r, METRIC_CODES.guest_sentiment_score))
  })
})
