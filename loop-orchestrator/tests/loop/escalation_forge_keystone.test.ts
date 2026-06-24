import {
  guardSpecsFor,
  loadCouplePersona,
  makePlannerSimulator,
  type Planner,
  rsvpCadencePlanner,
  scoreCandidateOffline,
  type ScenarioDefinition,
} from '@wedding-planner/eval-harness'
import {
  type CandidateChange,
  type EventEnvelope,
  genomeArtifactRef,
  type GuestPersona,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { buildEvent, createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import {
  ChampionStore,
  GenomeRegistry,
  HmacTransitionSigner,
  Ledger,
  runPromotionGate,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

/**
 * Phase-4b Step 5 — THE KEYSTONE: integrity forge-detection is LOAD-BEARING.
 *
 * The escalate-to-couple knob puts a forgeable claim directly on the North Star's resolution numerator
 * AND its couple-cost denominator (metrics are computed over the CLAIMED stream). Each arm injects a
 * LYING Stage A for the tier-2 candidate (the honest tier-1 baseline is untouched) and proves the same
 * RED/GREEN fact: the forge MOVES THE CLAIMED METRIC FAVOURABLY (a claims-trusting loop would reward it)
 * but the integrity gate produces a NEW gate failure vs the honest baseline (accept-rule condition 2),
 * so the candidate is REJECTED. The forge does not pay. The honest arm shows escalation can genuinely
 * win — yet still parks at the tier-2 gate (the two firewalls compose).
 */

const BASE_TS = '2027-06-01T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')
const INTEGRITY_CODE = 'INTEGRITY.SELF_REPORT_DIVERGENCE'

function guest(
  personaId: string,
  latency: GuestPersona['rsvp_truth']['response_latency'],
  will: GuestPersona['rsvp_truth']['will_attend'],
  coupleResolvable?: boolean,
): GuestPersona {
  return {
    persona_id: personaId,
    description: `g ${personaId}`,
    relationship: { to_couple: 'friend', side: 'both' },
    contact: { preferred_channel: 'email', preferred_language: 'en' },
    rsvp_truth: {
      will_attend: will,
      response_latency: latency,
      ...(coupleResolvable === undefined ? {} : { couple_resolvable: coupleResolvable }),
    },
    questions: [],
    personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
  }
}

// immediate (reminder-resolved) + a never-responder the couple CANNOT resolve (the forge target) +
// a never-responder the couple CAN resolve (honestly escalated → a trusted couple session to shave).
const GUESTS: readonly GuestPersona[] = [
  guest('g_immediate', 'immediate', 'yes'),
  guest('g_stranger', 'never', 'yes', false),
  guest('g_relative', 'never', 'yes', true),
]

function scenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
  return { scenario_id: id, scenario_type: type, couple: COUPLE, guests: GUESTS, bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.3 }] }
}
const CORPUS: readonly ScenarioDefinition[] = [scenario('golden_g', 'golden'), scenario('adv_a', 'adversarial')]

const CHAMPION: StrategyGenome = { genome_id: 'champ', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0 } }
const CANDIDATE: StrategyGenome = { genome_id: 'cand_t2', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0, autonomy_threshold: 1 } }

/** Append one event onto the planner's stream using its injected clock/ids (continues the sequence). */
function append(events: EventEnvelope[], input: Parameters<Planner>[0], eventName: string, actor: EventEnvelope['actor'], payload: Record<string, unknown>): void {
  events.push(
    buildEvent(input.clock, input.ids, {
      event_name: eventName,
      trace_id: `t_${input.scenario.scenario_id}`,
      wedding_id: input.scenario.scenario_id,
      phase: 'rsvp_window',
      capability: 'rsvp',
      actor,
      source: 'eval',
      payload,
      meta: { schema_version: '1.0.0' },
    }),
  )
  input.clock.advance(1000)
}

/** Score a tier-2 (lying) candidate against the honest tier-1 champion with an injected Stage-A planner. */
function score(planner: Planner) {
  const runner = makePlannerSimulator({ championGenome: CHAMPION, candidateGenome: CANDIDATE, candidateArtifactRef: genomeArtifactRef(CANDIDATE), baseTimestamp: BASE_TS, planner })
  return scoreCandidateOffline({ corpus: CORPUS, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone4b'), harnessVersion: 'h4b' })
}

const candValue = (r: ReturnType<typeof score>, code: string): number => r.candidate[0]?.metric_values[code] as number
const baseValue = (r: ReturnType<typeof score>, code: string): number => r.baseline[0]?.metric_values[code] as number
const integrityFailed = (r: ReturnType<typeof score>): boolean => r.decision.new_gate_failures.some((f) => f.includes(INTEGRITY_CODE))

// A liar that lies ONLY for the tier-2 candidate (autonomy_threshold present); the baseline stays honest.
function liar(mutate: (events: EventEnvelope[], input: Parameters<Planner>[0]) => EventEnvelope[]): Planner {
  return (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.parameters.autonomy_threshold === undefined) return honest
    return mutate(honest, input)
  }
}

describe('keystone — a FORGED couple-resolution does not pay (the metric-reads-claims P0)', () => {
  it('forges a couple-resolution for a NON-couple-resolvable guest: numerator up, but VETOED + rejected', () => {
    const r = score(
      liar((events, input) => {
        // Claim the couple resolved g_stranger (who is NOT couple-resolvable → no trusted outcome).
        append(events, input, EVENT_NAMES.couple_session_ended, 'couple', { session_id: 'cs_forge', about_guest_id: 'g_stranger', active_seconds: 600 })
        append(events, input, EVENT_NAMES.guest_rsvp_received, 'guest', { guest_id: 'g_stranger', rsvp_status: 'yes' })
        return events
      }),
    )
    expect(candValue(r, METRIC_CODES.rsvp_resolution_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.rsvp_resolution_rate)) // RED: the forge moved the metric
    expect(integrityFailed(r)).toBe(true) // GREEN: the firewall caught it
    expect(r.decision.accepted).toBe(false) // so it does not pay
  })

  it('forges a REMINDER-labeled resolution for a never-responder (no escalation vocabulary): still VETOED', () => {
    const r = score(
      liar((events, input) => {
        // No couple session — a plain reminder-attributed resolution, the bypass an escalation-only gate misses.
        append(events, input, EVENT_NAMES.guest_rsvp_received, 'guest', { guest_id: 'g_stranger', rsvp_status: 'yes' })
        return events
      }),
    )
    expect(candValue(r, METRIC_CODES.rsvp_resolution_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.rsvp_resolution_rate))
    expect(integrityFailed(r)).toBe(true)
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — a SHAVED couple-cost does not pay (the denominator forge)', () => {
  it('under-reports active_seconds on an honest escalation: denominator down, but VETOED + rejected', () => {
    const honestCost = candValue(score(rsvpCadencePlanner), METRIC_CODES.couple_active_minutes_total)
    const r = score(
      liar((events) =>
        events.map((e) =>
          e.event_name === EVENT_NAMES.couple_session_ended
            ? { ...e, payload: { ...(e.payload as Record<string, unknown>), active_seconds: 1 } }
            : e,
        ),
      ),
    )
    expect(candValue(r, METRIC_CODES.couple_active_minutes_total)).toBeLessThan(honestCost) // RED: shaved denominator
    expect(integrityFailed(r)).toBe(true) // GREEN
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — a SUPPRESSED couple-cost does not pay', () => {
  it('omits the couple.session.ended for an honest escalation: VETOED (suppressed_effect)', () => {
    const r = score(liar((events) => events.filter((e) => e.event_name !== EVENT_NAMES.couple_session_ended)))
    expect(integrityFailed(r)).toBe(true)
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — honest escalation genuinely WINS on resolution, yet still PARKS at the tier-2 gate', () => {
  it('accepted by the rule (escalation lifts resolution), but the promotion gate parks it (no approval)', () => {
    const r = score(rsvpCadencePlanner) // the HONEST planner: escalation resolves g_relative
    expect(candValue(r, METRIC_CODES.rsvp_resolution_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.rsvp_resolution_rate))
    expect(integrityFailed(r)).toBe(false) // honest claims match the trusted record
    expect(r.decision.accepted).toBe(true) // the escalate-to-couple win is real

    // The same accepted tier-2 candidate, at the promotion gate with NO approval, PARKS (the 4a rail).
    const registry = new GenomeRegistry()
    const artifactRef = registry.register(CANDIDATE)
    const championStore = new ChampionStore(CHAMPION)
    const ledger = new Ledger(new ManualClock(BASE_TS), new SequentialIdGenerator('parkLedger'), new HmacTransitionSigner('phase4b-key'))
    const candidate: CandidateChange = {
      candidate_id: 'cand_t2', created_at: BASE_TS, author: 'ai_proposer',
      hypothesis: { target_capability: 'rsvp', target_metric_code: 'rsvp_resolution_rate', target_scenario_ids: ['golden_g', 'adv_a'], expected_direction: 'increase', guards_to_watch: [], rationale: 'escalate-to-couple' },
      change: { change_type: 'flow', summary: 'tier-2 escalation', artifact_ref: artifactRef, reversible: true, capabilities_touched: ['rsvp'], mid_engagement_safe: true },
      risk_tier: 2, status: 'offline_passed',
    }
    ledger.append({ candidate_id: candidate.candidate_id, from_state: 'offline_scoring', to_state: 'offline_passed', decided_by: 'deterministic_selector', rationale: 'passed' })
    const outcome = runPromotionGate({ candidate, registry, championStore, ledger })
    expect(outcome).toBe('parked')
    expect(championStore.current()).toBe(CHAMPION) // the loop never self-granted tier-2 autonomy
  })
})

/**
 * PHASE-5 — the dilution-forge keystone: integrity forge-detection is load-bearing for the NEW tier-1
 * knob too. reminder_batching DILUTES reach (effectiveNudges = ceil(delivered/digestSize)), so a guest
 * reachable at batching 0 can be diluted OUT of resolution at batching ≥ 1. That SHRINKS the trusted
 * resolved set Stage B authors — the new forge surface: a lying Stage A can claim a resolution batching
 * diluted away (a plain reminder-attributed claim, no escalation vocabulary). The candidate is TIER-1
 * (batching, no autonomy_threshold), so there is no promotion-gate park to lean on — the INTEGRITY gate
 * is the sole stopper. This proves "forge-free for the new knob" is TESTED, not merely asserted (testineer P0).
 */
describe('keystone — a batching-DILUTED-AWAY resolution does not pay (the tier-1 dilution forge)', () => {
  // immediate (always resolves) + a guest needing 2 reminders that batching 1 dilutes out of reach.
  const dilGuests: readonly GuestPersona[] = [
    guest('g_immediate', 'immediate', 'yes'),
    guest('g_many', 'after_multiple_reminders', 'yes'),
  ]
  function dilScenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
    return { scenario_id: id, scenario_type: type, couple: COUPLE, guests: dilGuests, bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.3 }] }
  }
  const dilCorpus: readonly ScenarioDefinition[] = [dilScenario('golden_g', 'golden'), dilScenario('adv_a', 'adversarial')]
  // Champion cadence 1 (g_many unreached: rate 0.5). Candidate cadence 2 WOULD reach g_many at batching 0,
  // but batching 1 dilutes it (effectiveNudges = ceil(2/2) = 1 < 2) → honest candidate also rate 0.5.
  // Both tier-1 (no autonomy_threshold). So ONLY a forge can make the candidate "win".
  const dilChampion: StrategyGenome = { genome_id: 'champ_b', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0 } }
  const dilCandidate: StrategyGenome = { genome_id: 'cand_b', parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 1 } }

  function scoreDil(planner: Planner) {
    const runner = makePlannerSimulator({ championGenome: dilChampion, candidateGenome: dilCandidate, candidateArtifactRef: genomeArtifactRef(dilCandidate), baseTimestamp: BASE_TS, planner })
    return scoreCandidateOffline({ corpus: dilCorpus, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone5'), harnessVersion: 'h5' })
  }
  // A liar that claims g_many resolved (reminder-attributed) ONLY for the batching candidate (b > 0).
  const dilLiar: Planner = (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.parameters.reminder_batching === 0) return honest // baseline stays honest
    append(honest, input, EVENT_NAMES.guest_rsvp_received, 'guest', { guest_id: 'g_many', rsvp_status: 'yes' })
    return honest
  }

  it('claims a resolution batching diluted away: numerator up vs champion, but VETOED + rejected', () => {
    const r = scoreDil(dilLiar)
    expect(candValue(r, METRIC_CODES.rsvp_resolution_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.rsvp_resolution_rate)) // RED: the forge moved the metric above the champion
    expect(integrityFailed(r)).toBe(true) // GREEN: Stage B authored no trusted outcome for g_many → forged_effect
    expect(r.decision.accepted).toBe(false) // the forge does not pay
  })

  it('the HONEST batching candidate is gate-CLEAN — the veto targets the lie, not batching itself', () => {
    const r = scoreDil(rsvpCadencePlanner)
    expect(integrityFailed(r)).toBe(false) // honest claims (g_many diluted out, unclaimed) match the trusted record
  })
})
