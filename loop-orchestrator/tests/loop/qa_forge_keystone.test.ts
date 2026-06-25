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
 * Phase-7 KEYSTONE — Q&A forge-detection is LOAD-BEARING.
 *
 * `qa_accuracy_rate` (a third of the `completeness` North-Star component) is scored over the CLAIMED
 * `guest.question.answered` stream: an answer is correct iff `action_taken` matches the required action
 * for `answerable_by_expected`. Honest Q&A competence is GENOME-DEPENDENT: a `requires_couple` question
 * is handled correctly only by ESCALATING, which requires the tier-2 `autonomy_threshold`; a TIER-1
 * genome honestly ANSWERS it (incorrect, qa < 1). Before Phase 7 this metric had no trusted backing —
 * a lying planner could CLAIM it escalated (or relabel the question, or suppress/dilute the wrong
 * answer) and inflate completeness for free. Phase 7 gives every question a trusted Q&A outcome (Stage
 * B) so the integrity gate reconciles the claim.
 *
 * The corpus: an immediate guest with a `requires_couple` question (honest tier-1 qa contribution = 0,
 * answered≠escalated) + an immediate guest with an `ai_from_known_facts` question (correct). Both guests
 * are immediate, so RSVP resolves at every cadence and sentiment is flat — the ONLY thing the forge can
 * move is qa. Champion (cadence 1) and candidate (cadence 2) are BOTH TIER-1, so their honest runs are
 * identical (qa 0.5 each) and there is no promotion-gate park — the INTEGRITY gate is the SOLE stopper.
 * Each arm proves the same RED/GREEN fact: the forge moves `qa_accuracy_rate` ABOVE the champion (a
 * claims-trusting loop would reward it) but produces a NEW integrity failure vs the honest baseline
 * (accept-rule condition 2), so it is REJECTED. (A tier-1 candidate cannot honestly reach a tier-2
 * champion's qa either, but that needs a modeled QA-escalation couple cost — deferred; this keystone
 * proves the firewall against the simpler, real inflation: a tier-1 forging qa it cannot honestly earn.)
 */

const BASE_TS = '2027-09-01T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')
const INTEGRITY_CODE = 'INTEGRITY.SELF_REPORT_DIVERGENCE'

function guestWithQuestion(
  personaId: string,
  answerableBy: GuestPersona['questions'][number]['answerable_by'],
): GuestPersona {
  return {
    persona_id: personaId,
    description: `g ${personaId}`,
    relationship: { to_couple: 'friend', side: 'both' },
    contact: { preferred_channel: 'email', preferred_language: 'en' },
    rsvp_truth: { will_attend: 'yes', response_latency: 'immediate' },
    questions: [{ question_id: `${personaId}_q`, text: 'q', expected_answer: 'a', answerable_by: answerableBy }],
    personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
  }
}

// One requires_couple question (honest tier-1: answered, INCORRECT) + one ai question (correct).
// Honest qa over the pair = 1 correct / 2 answered = 0.5 for both tier-1 genomes.
const GUESTS: readonly GuestPersona[] = [
  guestWithQuestion('g_couple', 'requires_couple'),
  guestWithQuestion('g_ai', 'ai_from_known_facts'),
]

function scenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
  return { scenario_id: id, scenario_type: type, couple: COUPLE, guests: GUESTS, bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'qa_accuracy_rate', direction: 'gte', threshold: 0.3 }] }
}
const CORPUS: readonly ScenarioDefinition[] = [scenario('golden_g', 'golden'), scenario('adv_a', 'adversarial')]

// Both TIER-1 (no autonomy_threshold). Identical honest behaviour; they differ only in cadence so the
// liar can target the candidate (cadence 2), exactly as the sentiment keystone does.
const CHAMPION: StrategyGenome = { genome_id: 'champ', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, reminder_batching: 0 } }
const CANDIDATE: StrategyGenome = { genome_id: 'cand', parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 0, reminder_batching: 0 } }

function score(planner: Planner) {
  const runner = makePlannerSimulator({ championGenome: CHAMPION, candidateGenome: CANDIDATE, candidateArtifactRef: genomeArtifactRef(CANDIDATE), baseTimestamp: BASE_TS, planner })
  return scoreCandidateOffline({ corpus: CORPUS, runner, guards: guardSpecsFor([]), metricEngine: createMetricEngine(), clock: new ManualClock(BASE_TS), ids: new SequentialIdGenerator('keystone7'), harnessVersion: 'h7' })
}

const candValue = (r: ReturnType<typeof score>, code: string): number => r.candidate[0]?.metric_values[code] as number
const baseValue = (r: ReturnType<typeof score>, code: string): number => r.baseline[0]?.metric_values[code] as number
const integrityFailed = (r: ReturnType<typeof score>): boolean => r.decision.new_gate_failures.some((f) => f.includes(INTEGRITY_CODE))

const isAnswer = (e: EventEnvelope, guestId: string): boolean =>
  e.event_name === EVENT_NAMES.guest_question_answered && (e.payload as { guest_id: string }).guest_id === guestId

// A liar that lies ONLY for the candidate (cadence 2); the champion (cadence 1) stays honest.
function liar(mutate: (events: EventEnvelope[]) => EventEnvelope[]): Planner {
  return (input) => {
    const honest = [...rsvpCadencePlanner(input)]
    if (input.genome.parameters.rsvp_reminder_cadence !== 2) return honest
    return mutate(honest)
  }
}

describe('keystone — CLAIMING escalation of a requires_couple question does not pay (the tier-1 Q&A forge)', () => {
  it('claims action_taken=escalated (tier-2-grade handling it cannot do): qa up vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) =>
        events.map((e) =>
          isAnswer(e, 'g_couple')
            ? { ...e, payload: { ...(e.payload as Record<string, unknown>), action_taken: 'escalated' } }
            : e,
        ),
      ),
    )
    expect(candValue(r, METRIC_CODES.qa_accuracy_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.qa_accuracy_rate)) // RED: 1.0 > 0.5
    expect(integrityFailed(r)).toBe(true) // GREEN: claimed escalated ≠ trusted answered → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — RELABELLING the question does not pay (forge correctness via the answerable_by mapping)', () => {
  it('claims the couple-question is ai_from_known_facts so a truthful answered scores correct: VETOED + rejected', () => {
    const r = score(
      liar((events) =>
        events.map((e) =>
          isAnswer(e, 'g_couple')
            ? { ...e, payload: { ...(e.payload as Record<string, unknown>), answerable_by_expected: 'ai_from_known_facts' } }
            : e,
        ),
      ),
    )
    expect(candValue(r, METRIC_CODES.qa_accuracy_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.qa_accuracy_rate)) // RED
    expect(integrityFailed(r)).toBe(true) // GREEN: claimed answerable_by ≠ trusted requires_couple → field_mismatch
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — SUPPRESSING the wrong answer does not pay (claims-only denominator)', () => {
  it('omits the requires_couple answer (drops a 0 from the rate): qa up vs champion, but VETOED + rejected', () => {
    const r = score(liar((events) => events.filter((e) => !isAnswer(e, 'g_couple'))))
    expect(candValue(r, METRIC_CODES.qa_accuracy_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.qa_accuracy_rate)) // RED: 1/1 > 1/2
    expect(integrityFailed(r)).toBe(true) // GREEN: a trusted question with no claim → suppressed_effect
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — DUPLICATING a correct answer does not pay (diluting the wrong one)', () => {
  it('re-emits the ai question’s correct answer to dilute the wrong one: qa up vs champion, but VETOED + rejected', () => {
    const r = score(
      liar((events) => {
        const dup = events.find((e) => isAnswer(e, 'g_ai'))
        return dup === undefined ? events : [...events, dup]
      }),
    )
    expect(candValue(r, METRIC_CODES.qa_accuracy_rate)).toBeGreaterThan(baseValue(r, METRIC_CODES.qa_accuracy_rate)) // RED: 2/3 > 1/2
    expect(integrityFailed(r)).toBe(true) // GREEN: a 2nd answer for an already-claimed question → forged
    expect(r.decision.accepted).toBe(false)
  })
})

describe('keystone — the HONEST candidate is gate-CLEAN (the veto targets the lie, not the model)', () => {
  it('honest Q&A claims match the trusted record; the candidate ties the champion and does not win', () => {
    const r = score(rsvpCadencePlanner)
    expect(integrityFailed(r)).toBe(false) // honest claims (g_couple answered, g_ai answered) match trusted
    expect(candValue(r, METRIC_CODES.qa_accuracy_rate)).toBe(baseValue(r, METRIC_CODES.qa_accuracy_rate)) // both 0.5
    expect(r.decision.accepted).toBe(false) // a tie does not improve the aggregate (condition 4) — no honest win to forge over
  })
})
