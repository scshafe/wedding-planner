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
  MESSAGE_COST_CENTS,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Phase-20 KEYSTONE — the per-message MONEY firewall is LOAD-BEARING, and the money term is LIVE.
 *
 * `messaging_money_total_cents` (Σ guest.messaging.metered.message_count × MESSAGE_COST_CENTS[channel]) feeds
 * the North-Star money_cost DENOMINATOR (summed with budget_variance_pct). It is the FIRST North-Star term
 * moved DIRECTLY by the tier-1 search knobs (cadence/spacing/batching all move the digest send count
 * feltTouches), not via the tier-2 autonomy_threshold — so unlike Phases 7-10 the money term enters the
 * search corpus and the search trades real money.
 *
 * Two things this keystone proves:
 *   (A) THE TERM IS LIVE — messaging_money_total_cents strictly rises with cadence at (spacing 1, batching 0)
 *       (the cell wolf flagged as genuinely strict; it is FLAT 1->2 at the b=1 optimum where the digest
 *       absorbs a send, so do NOT assert strict monotonicity there), and a higher messaging cost STRICTLY
 *       lowers the North-Star ratio at fixed planning_value (the knife-edge-free load-bearing relation).
 *   (B) THE FIREWALL IS LOAD-BEARING — money_cost is LOWER-better, so the incentive is to UNDER-report. A
 *       candidate that sends messages honestly (keeps resolution/sentiment) but SHAVES the count, DOWNGRADES
 *       the channel, or SUPPRESSES the metered claim lowers the summed cost below the champion → a higher
 *       ratio ABSENT the gate (`forgeWouldWinAbsentGate`) → but the integrity gate's 9th effect kind
 *       reconciles the claimed channel + count, so each forge is the SOLE new failure (`onlyIntegrityFailed`)
 *       and REJECTED.
 *
 * Champion and candidate carry IDENTICAL parameters (so their honest runs are byte-identical and the messaging
 * cost is the SOLE mover) and differ only by genome_id; the liar targets the candidate by genome_id. The
 * guests are on SMS (2c) so the channel-downgrade arm has a cheaper channel (email 1c) to forge toward.
 */

const BASE_TS = '2027-12-08T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')
const INTEGRITY_CODE = 'INTEGRITY.SELF_REPORT_DIVERGENCE'

function smsGuest(personaId: string, latency: GuestPersona['rsvp_truth']['response_latency'], will: GuestPersona['rsvp_truth']['will_attend'] = 'yes'): GuestPersona {
  return {
    persona_id: personaId,
    description: `g ${personaId}`,
    relationship: { to_couple: 'friend', side: 'both' },
    contact: { preferred_channel: 'sms', preferred_language: 'en' },
    rsvp_truth: { will_attend: will, response_latency: latency },
    questions: [],
    personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
  }
}

// At the shared (cadence 2, spacing 0, batching 0) on sms: an immediate (0 sends, some planning_value), a
// one-reminder responder (1 send = 2c), and a never-responder (2 sends = 4c). TWO senders so SUPPRESSING the
// never-responder's claim still leaves a DEFINED-but-lower metric (the one-reminder guest's 2c).
const GUESTS: readonly GuestPersona[] = [
  smsGuest('g_immediate', 'immediate', 'yes'),
  smsGuest('g_one', 'after_one_reminder', 'yes'),
  smsGuest('g_never', 'never', 'maybe_needs_nudge'),
]

function scenario(id: string, type: ScenarioDefinition['scenario_type'], guests: readonly GuestPersona[] = GUESTS): ScenarioDefinition {
  return {
    scenario_id: id,
    scenario_type: type,
    couple: COUPLE,
    guests,
    bookedPlanFacts: {},
    targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.3 }],
  }
}
const CORPUS: readonly ScenarioDefinition[] = [scenario('golden_g', 'golden'), scenario('adv_a', 'adversarial')]

// IDENTICAL parameters; they differ only by genome_id so the honest runs are byte-identical and the liar can
// target the candidate while the messaging cost is the sole mover.
const PARAMS = { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 0 }
const CHAMPION: StrategyGenome = { genome_id: 'champ', parameters: { ...PARAMS } }
const CANDIDATE: StrategyGenome = { genome_id: 'cand', parameters: { ...PARAMS } }

function score(planner: Planner) {
  const runner = makePlannerSimulator({ championGenome: CHAMPION, candidateGenome: CANDIDATE, candidateArtifactRef: genomeArtifactRef(CANDIDATE), baseTimestamp: BASE_TS, planner })
  return scoreCandidateOffline({ corpus: CORPUS, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone20'), harnessVersion: 'h20' })
}

const candValue = (r: ReturnType<typeof score>, code: string): number => r.candidate[0]?.metric_values[code] as number
const baseValue = (r: ReturnType<typeof score>, code: string): number => r.baseline[0]?.metric_values[code] as number
const integrityFailed = (r: ReturnType<typeof score>): boolean => r.decision.new_gate_failures.some((f) => f.includes(INTEGRITY_CODE))
const onlyIntegrityFailed = (r: ReturnType<typeof score>): boolean =>
  r.decision.new_gate_failures.length > 0 && r.decision.new_gate_failures.every((f) => f.includes(INTEGRITY_CODE))

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

const isMetered = (e: EventEnvelope, guestId: string): boolean =>
  e.event_name === EVENT_NAMES.guest_messaging_metered && (e.payload as { guest_id?: string }).guest_id === guestId

/** A liar that lies ONLY for the candidate (genome_id 'cand'); the champion stays honest. */
function liar(mutate: (events: EventEnvelope[]) => EventEnvelope[]): Planner {
  return (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.genome_id !== 'cand') return honest
    return mutate(honest)
  }
}

// ---------------------------------------------------------------------------------------------------
// (A) The money term is LIVE.
// ---------------------------------------------------------------------------------------------------

describe('keystone — the messaging money term is LIVE in the search', () => {
  const engine = createMetricEngine()
  function meteredCents(cadence: number, spacing: number, batching: number): number {
    const g: StrategyGenome = { genome_id: `g_${cadence}_${spacing}_${batching}`, parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: spacing, reminder_batching: batching } }
    const scn = scenario('s_live', 'golden', [smsGuest('gi', 'immediate'), smsGuest('go', 'after_one_reminder'), smsGuest('gm', 'after_multiple_reminders', 'no'), smsGuest('gn', 'never', 'maybe_needs_nudge')])
    const events = makePlannerSimulator({ championGenome: g, candidateGenome: g, candidateArtifactRef: genomeArtifactRef(g), baseTimestamp: BASE_TS })(scn, 'candidate').productEvents
    const comps = engine.computeMany(engine.metricCodes(), events, scn.scenario_id)
    return (comps.find((c) => c.metric_code === METRIC_CODES.messaging_money_total_cents)?.value as number) ?? 0
  }

  it('messaging_money_total_cents STRICTLY rises with cadence at (spacing 1, batching 0)', () => {
    // The genuinely-strict cell (wolf): [0,3,5,6] sends × the sms 2c basis. (At the b=1 optimum the column is
    // flat 1->2 — the digest absorbs a send — so monotonicity must be asserted HERE, not at the optimum.)
    const cents = [0, 1, 2, 3].map((c) => meteredCents(c, 1, 0))
    for (let i = 1; i < cents.length; i += 1) {
      expect(cents[i], `cadence ${i} must cost more than ${i - 1}`).toBeGreaterThan(cents[i - 1] as number)
    }
    expect(cents[0]).toBe(0) // cadence 0 sends nothing
  })

  it('batching CONSOLIDATES sends → costs LESS at a fixed cadence (the batching money upside)', () => {
    // The batching cost-saving the human constraint names: at cadence 3, spacing 0, raising batching bundles
    // sends into fewer digests, so messaging_money_total_cents falls (b0 -> b1).
    expect(meteredCents(3, 0, 1)).toBeLessThan(meteredCents(3, 0, 0))
  })

  it('a higher messaging cost STRICTLY lowers the North-Star ratio at fixed planning_value (load-bearing, knife-edge-free)', () => {
    const pv = { quality: null, completeness: 0.6, guest_experience: 0.5, effort_cost: 0, stress_cost: null }
    const cheaper = computeNorthStar({ ...pv, money_cost: deriveNorthStarInputs({ messaging_money_total_cents: 4 }, COUPLE).money_cost }, false)
    const dearer = computeNorthStar({ ...pv, money_cost: deriveNorthStarInputs({ messaging_money_total_cents: 8 }, COUPLE).money_cost }, false)
    expect(dearer.ratio).toBeLessThan(cheaper.ratio)
  })
})

// ---------------------------------------------------------------------------------------------------
// (B) The firewall is load-bearing — every under-report is vetoed.
// ---------------------------------------------------------------------------------------------------

describe('keystone — SHAVING the message_count does not pay', () => {
  it('under-reports the count: messaging cost down vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) => events.map((e) => (isMetered(e, 'g_never') ? { ...e, payload: { ...(e.payload as Record<string, unknown>), message_count: 1 } } : e))),
    )
    expect(candValue(r, METRIC_CODES.messaging_money_total_cents)).toBeLessThan(baseValue(r, METRIC_CODES.messaging_money_total_cents))
    expect(forgeWouldWinAbsentGate(r)).toBe(true) // lower denominator ⇒ higher ratio absent the gate...
    expect(onlyIntegrityFailed(r)).toBe(true) // ...but claimed message_count ≠ trusted → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — DOWNGRADING the channel does not pay', () => {
  it('claims the cheaper email channel for an sms guest: cost down vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) => events.map((e) => (isMetered(e, 'g_never') ? { ...e, payload: { ...(e.payload as Record<string, unknown>), channel: 'email' } } : e))),
    )
    expect(candValue(r, METRIC_CODES.messaging_money_total_cents)).toBeLessThan(baseValue(r, METRIC_CODES.messaging_money_total_cents))
    expect(MESSAGE_COST_CENTS.email).toBeLessThan(MESSAGE_COST_CENTS.sms) // the downgrade is genuinely cheaper
    expect(forgeWouldWinAbsentGate(r)).toBe(true)
    expect(onlyIntegrityFailed(r)).toBe(true) // claimed channel ≠ trusted → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — SUPPRESSING the metered claim does not pay', () => {
  it('drops the never-responder`s metered claim entirely: cost down vs champion, but VETOED + rejected', () => {
    const r = score(liar((events) => events.filter((e) => !isMetered(e, 'g_never'))))
    expect(candValue(r, METRIC_CODES.messaging_money_total_cents)).toBeLessThan(baseValue(r, METRIC_CODES.messaging_money_total_cents))
    expect(forgeWouldWinAbsentGate(r)).toBe(true)
    expect(onlyIntegrityFailed(r)).toBe(true) // a trusted spend with no claim → suppressed_effect
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — the HONEST candidate is gate-CLEAN (the veto targets the lie, not the model)', () => {
  it('honest metered claims match the trusted record; the candidate ties the champion and does not win', () => {
    const r = score(rsvpCadencePlanner)
    expect(integrityFailed(r)).toBe(false)
    expect(r.decision.new_gate_failures).toEqual([])
    expect(candValue(r, METRIC_CODES.messaging_money_total_cents)).toBe(baseValue(r, METRIC_CODES.messaging_money_total_cents))
    expect(r.decision.accepted).toBe(false) // a tie does not improve the aggregate — no honest win to forge over
  })
})
