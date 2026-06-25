import { EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import {
  type GuestPersona,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import {
  checkIntegritySelfReportDivergence,
  detectSelfReportDivergence,
  observeTrustedRecord,
  rsvpCadencePlanner,
} from '@wedding-planner/eval-harness'

import {
  makeGenome,
  makeGuest,
  makeRequiredCategory,
  makeScenario,
  makeTier2Genome,
} from './simulator_fixtures'

/**
 * Phase-4b Step 2: Stage B independently authors the trusted RSVP-outcome + couple-session record from
 * (scenario, genome) ground truth ALONE. These tests pin WHAT it authors and — critically — that the
 * HONEST Stage A reproduces exactly Stage B's reminder-resolved set (the agreement the Step-3 integrity
 * gate relies on so honest runs stay green).
 */

const BASE_TS = '2026-02-01T00:00:00.000Z'

/** The set of guest_ids the HONEST Stage A claims it resolved, for a genome over a scenario. */
function honestResolvedGuestIds(genome: StrategyGenome, scenarioGuests: ReturnType<typeof makeGuest>[]): Set<string> {
  const scenario = makeScenario('s_honest', scenarioGuests)
  const events = rsvpCadencePlanner({
    scenario,
    genome,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('sb_test'),
  })
  return new Set(
    events
      .filter((e) => e.event_name === EVENT_NAMES.guest_rsvp_received)
      .map((e) => (e.payload as { guest_id: string }).guest_id),
  )
}

/** The per-guest sentiment scores the HONEST Stage A claims, for a genome over a scenario. */
function honestClaimedSentiment(genome: StrategyGenome, scenarioGuests: ReturnType<typeof makeGuest>[]): Map<string, number> {
  const events = rsvpCadencePlanner({
    scenario: makeScenario('s_honest', scenarioGuests),
    genome,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('sb_sent'),
  })
  const byGuest = new Map<string, number>()
  for (const e of events.filter((ev) => ev.event_name === EVENT_NAMES.guest_sentiment_sampled)) {
    const p = e.payload as { guest_id: string; sentiment_score: number }
    byGuest.set(p.guest_id, p.sentiment_score)
  }
  return byGuest
}

describe('Stage B — trusted RSVP-outcome authoring (reminder path, tier-1 genome)', () => {
  const guests = [
    makeGuest('g_immediate', 'immediate', 'yes'),
    makeGuest('g_one', 'after_one_reminder', 'yes'),
    makeGuest('g_many', 'after_multiple_reminders', 'no'),
    makeGuest('g_never', 'never', 'maybe_needs_nudge'),
  ]

  it('records a reminder-resolved outcome for exactly the guests cadence/spacing reach, and no couple sessions', () => {
    const genome = makeGenome(1, 0) // cadence 1: reaches immediate (0) + one_reminder (1); not many (2)/never
    const recorder = observeTrustedRecord(makeScenario('s', guests), genome)

    const resolved = recorder.allRsvpOutcomes()
    expect(resolved.map((r) => r.guest_id).sort()).toEqual(['g_immediate', 'g_one'])
    expect(resolved.every((r) => r.resolved_via === 'reminder')).toBe(true)
    expect(recorder.rsvpOutcome('g_immediate')?.rsvp_status).toBe('yes')
    // No tier-2 knob ⇒ no escalation, no couple cost.
    expect(recorder.allCoupleSessions()).toHaveLength(0)
  })

  it('agrees with the HONEST Stage A claimed resolution set over the FULL 3-D box (the gate-green prerequisite)', () => {
    // Phase 5: the sweep is now the whole cadence×spacing×batching cube (64 points). Stage A's reach
    // dilution (effectiveNudges) and Stage B's trusted reminder-resolution MUST agree at every point, or
    // an honest batched genome would self-veto on the integrity gate (suppressed/forged resolution).
    for (const cadence of [0, 1, 2, 3]) {
      for (const spacing of [0, 1, 2, 3]) {
        for (const batching of [0, 1, 2, 3]) {
          const genome = makeGenome(cadence, spacing, batching)
          const trusted = new Set(
            observeTrustedRecord(makeScenario('s', guests), genome)
              .allRsvpOutcomes()
              .map((r) => r.guest_id),
          )
          expect(honestResolvedGuestIds(genome, guests), `c${cadence} s${spacing} b${batching}`).toEqual(trusted)
        }
      }
    }
  })

  it('records a trusted sentiment observation per guest that EXACTLY equals the honest Stage A claim over the full 3-D box (Phase 6)', () => {
    // The integrity gate field-diffs the claimed sentiment_score against this trusted score with EXACT
    // equality. Because both stages call the SAME honestSentimentScore fact on the same primitives, the
    // values are bit-identical — pin that across the whole cube × latencies so no honest run self-vetoes.
    for (const cadence of [0, 1, 2, 3]) {
      for (const spacing of [0, 1, 2, 3]) {
        for (const batching of [0, 1, 2, 3]) {
          const genome = makeGenome(cadence, spacing, batching)
          const recorder = observeTrustedRecord(makeScenario('s', guests), genome)
          const trusted = new Map(recorder.allSentimentObservations().map((o) => [o.guest_id, o.sentiment_score]))
          const claimed = honestClaimedSentiment(genome, guests)
          // Every guest is sampled exactly once on both sides (no missing/extra observation).
          expect(trusted.size).toBe(guests.length)
          expect([...claimed.keys()].sort()).toEqual([...trusted.keys()].sort())
          for (const guest of guests) {
            const id = guest.persona_id
            expect(trusted.get(id), `c${cadence} s${spacing} b${batching} ${id}`).toBe(claimed.get(id))
          }
        }
      }
    }
  })
})

describe('Stage B — couple escalation authoring (tier-2 genome)', () => {
  // Two never-responders to reminders; one is couple-resolvable, one is not.
  const guests = [
    makeGuest('g_immediate', 'immediate', 'yes'),
    makeGuest('g_relative', 'never', 'yes', true), // couple can call them
    makeGuest('g_stranger', 'never', 'no', false), // couple cannot resolve
  ]

  it('escalates pending couple-resolvable guests (resolution + couple cost); skips non-resolvable', () => {
    const recorder = observeTrustedRecord(makeScenario('s', guests), makeTier2Genome(1, 0, 1))

    // g_immediate via reminder; g_relative via couple; g_stranger never resolved.
    expect(recorder.rsvpOutcome('g_immediate')?.resolved_via).toBe('reminder')
    expect(recorder.rsvpOutcome('g_relative')?.resolved_via).toBe('couple')
    expect(recorder.rsvpOutcome('g_relative')?.rsvp_status).toBe('yes')
    expect(recorder.rsvpOutcome('g_stranger')).toBeUndefined()

    // The escalation consumed exactly one couple session (the cost), keyed by the escalated guest.
    const sessions = recorder.allCoupleSessions()
    expect(sessions.map((s) => s.guest_id)).toEqual(['g_relative'])
    expect(sessions[0]?.active_seconds).toBeGreaterThan(0)
  })

  it('is monotone in autonomy_threshold: a higher threshold escalates at least as many guests', () => {
    const many = [
      makeGuest('g_a', 'never', 'yes', true),
      makeGuest('g_b', 'never', 'yes', true),
      makeGuest('g_c', 'never', 'yes', true),
    ]
    const count = (t: number): number =>
      observeTrustedRecord(makeScenario('s', many), makeTier2Genome(0, 0, t)).allCoupleSessions().length
    expect(count(1)).toBe(1)
    expect(count(2)).toBe(2)
    expect(count(3)).toBe(3) // threshold 3 = escalate all pending couple-resolvable
    expect(count(1)).toBeLessThanOrEqual(count(2))
    expect(count(2)).toBeLessThanOrEqual(count(3))
  })
})

// ---------------------------------------------------------------------------------------------------
// PHASE 7 — Stage B authors a trusted Q&A outcome per scripted question; agreement with honest Stage A.
// ---------------------------------------------------------------------------------------------------

type AnswerableBy = GuestPersona['questions'][number]['answerable_by']

/** A guest carrying one scripted question of a given nature (makeGuest gives questions:[]). */
function guestQ(personaId: string, answerableBy: AnswerableBy): GuestPersona {
  return {
    ...makeGuest(personaId, 'immediate', 'yes'),
    questions: [
      { question_id: `${personaId}_q`, text: 'q', expected_answer: 'a', answerable_by: answerableBy },
    ],
  }
}

/** The (guest_id|question_id) → {action_taken, answerable_by_expected} the HONEST Stage A claims. */
function honestClaimedQa(
  genome: StrategyGenome,
  scenarioGuests: GuestPersona[],
): Map<string, { action: string; answerable: string }> {
  const events = rsvpCadencePlanner({
    scenario: makeScenario('s_honest', scenarioGuests),
    genome,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('sb_qa'),
  })
  const byKey = new Map<string, { action: string; answerable: string }>()
  for (const e of events.filter((ev) => ev.event_name === EVENT_NAMES.guest_question_answered)) {
    const p = e.payload as { guest_id: string; question_id: string; action_taken: string; answerable_by_expected: string }
    byKey.set(`${p.guest_id}|${p.question_id}`, { action: p.action_taken, answerable: p.answerable_by_expected })
  }
  return byKey
}

describe('Stage B — trusted Q&A authoring agrees EXACTLY with honest Stage A across answerable_by × tier (Phase 7)', () => {
  const GUESTS: GuestPersona[] = [
    guestQ('g_ai', 'ai_from_known_facts'),
    guestQ('g_couple', 'requires_couple'),
    guestQ('g_refuse', 'must_refuse'),
  ]

  // The gate field-diffs claimed action_taken AND answerable_by_expected against the trusted record with
  // exact equality. Both stages call honestQaAction on the same (answerable_by, canEscalate), so they are
  // bit-identical — pin that for BOTH tiers (the tier-1 requires_couple→answered case is the only one
  // where honest != required, and the only one that could silently self-veto if the stages diverged).
  for (const [label, genome] of [
    ['tier-1', makeGenome(2, 0)],
    ['tier-2', makeTier2Genome(2, 0, 1)],
  ] as const) {
    it(`trusted (action, answerable_by) == honest claim for every question (${label})`, () => {
      const recorder = observeTrustedRecord(makeScenario('s_qa', GUESTS), genome)
      const trusted = new Map(
        recorder.allQaOutcomes().map((o) => [`${o.guest_id}|${o.question_id}`, { action: o.action_taken, answerable: o.answerable_by }]),
      )
      expect(trusted).toEqual(honestClaimedQa(genome, GUESTS))
      expect(trusted.size).toBe(3)
    })
  }

  it('records ONE outcome per question and NONE for a question-free guest', () => {
    const recorder = observeTrustedRecord(makeScenario('s_qa_mixed', [guestQ('g_ai', 'ai_from_known_facts'), makeGuest('g_plain', 'immediate')]), makeGenome(2, 0))
    expect(recorder.allQaOutcomes().map((o) => o.guest_id)).toEqual(['g_ai'])
  })
})

// ---------------------------------------------------------------------------------------------------
// PHASE 8 — Stage B authors a trusted category booking per required category; honest-run audit clean.
// ---------------------------------------------------------------------------------------------------

const REQUIRED_CATEGORIES = [
  makeRequiredCategory('cat_inv', 'invitations', false), // approval-free → booked at any tier
  makeRequiredCategory('cat_venue', 'venue', true), // approval-required → booked only at tier-2
]

/** Guests whose RSVP + sentiment resolve cleanly, so the only Phase-8-relevant effect is the category one. */
const CATEGORY_AUDIT_GUESTS = [makeGuest('g_immediate', 'immediate', 'yes')]

/** The category_id → booking_status the HONEST Stage A claims, for a genome over a scenario. */
function honestClaimedCategories(
  genome: StrategyGenome,
  scenario: ReturnType<typeof makeScenario>,
): Map<string, string> {
  const events = rsvpCadencePlanner({
    scenario,
    genome,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('sb_cat'),
  })
  const byId = new Map<string, string>()
  for (const e of events.filter((ev) => ev.event_name === EVENT_NAMES.category_booked)) {
    const p = e.payload as { category_id: string; booking_status: string }
    byId.set(p.category_id, p.booking_status)
  }
  return byId
}

describe('Stage B — trusted category authoring agrees with honest Stage A; honest run is INTEGRITY-clean (Phase 8)', () => {
  for (const [label, genome] of [
    ['tier-1', makeGenome(2, 0)],
    ['tier-2', makeTier2Genome(2, 0, 1)],
  ] as const) {
    it(`trusted booking_status == honest claim for every required category (${label})`, () => {
      const scenario = makeScenario('s_cat', CATEGORY_AUDIT_GUESTS, 'golden', REQUIRED_CATEGORIES)
      const recorder = observeTrustedRecord(scenario, genome)
      const trusted = new Map(recorder.allCategoryBookings().map((b) => [b.category_id, b.booking_status]))
      expect(trusted).toEqual(honestClaimedCategories(genome, scenario))
      expect(trusted.size).toBe(2)
    })

    it(`a full HONEST run over a category-bearing scenario produces ZERO integrity divergences (${label})`, () => {
      // The honest-suite-clean audit: Stage A's claims and Stage B's trusted record agree across every
      // effect kind (rsvp/sentiment/category), so the gate passes. Were the stages to diverge on the
      // tier-1 deferred category, this would self-veto every honest tier-1 run.
      const scenario = makeScenario('s_cat_audit', CATEGORY_AUDIT_GUESTS, 'golden', REQUIRED_CATEGORIES)
      const recorder = observeTrustedRecord(scenario, genome)
      const events = rsvpCadencePlanner({
        scenario,
        genome,
        clock: new ManualClock(BASE_TS),
        ids: new SequentialIdGenerator('sb_cat_audit'),
      })
      const categoryDivs = detectSelfReportDivergence(events, recorder).filter((d) => d.effect_kind === 'category_booking')
      expect(categoryDivs).toEqual([])
      expect(checkIntegritySelfReportDivergence(events, recorder).passed).toBe(true)
    })
  }
})
