import { detectSelfReportDivergence, makePlannerSimulator, type ScenarioDefinition } from '@wedding-planner/eval-harness'
import { EVENT_NAMES } from '@wedding-planner/telemetry'
import { type GuestPersona } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  makeGenome,
  makeGuest,
  makeRequiredCategory,
  makeScenario,
  makeTier2Genome,
  refFor,
} from './simulator_fixtures'

/**
 * Phase-9 Steps 4 + 6: Stage A emits one `couple.session.ended` per honest booking-approval /
 * qa-escalation; Stage B records the matching trusted session from the SAME shared facts. The cost is
 * GENOME-DEPENDENT (only a tier-2 genome escalates / secures approval), so honest sessions appear ONLY at
 * tier-2 on approval-required items. Honest Stage-A claims MUST equal the Stage-B trusted record (the
 * integrity gate field-diffs `active_seconds` with `===`) — so an honest run reconciles with ZERO
 * divergences. A category/question-FREE scenario (the search corpus) emits ZERO new sessions: byte-identity.
 */

const BASE_TS = '2027-11-01T12:00:00.000Z'

function run(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition) {
  const sim = makePlannerSimulator({
    championGenome: genome,
    candidateGenome: genome,
    candidateArtifactRef: refFor(genome),
    baseTimestamp: BASE_TS,
  })
  return sim(scenario, 'candidate')
}

/** Every claimed couple session as `${session_reason}/${about_id}`. */
function claimedSessions(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): string[] {
  return run(genome, scenario)
    .productEvents.filter((e) => e.event_name === EVENT_NAMES.couple_session_ended)
    .map((e) => {
      const p = e.payload as { session_reason: string; about_id: string }
      return `${p.session_reason}/${p.about_id}`
    })
    .sort()
}

/** Every trusted couple session as `${session_reason}/${about_id}`. */
function trustedSessions(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): string[] {
  return run(genome, scenario)
    .recorder.allCoupleSessions()
    .map((s) => `${s.session_reason}/${s.about_id}`)
    .sort()
}

function guestWithQuestion(
  personaId: string,
  answerableBy: GuestPersona['questions'][number]['answerable_by'],
  coupleResolvable?: boolean,
): GuestPersona {
  const base = makeGuest(personaId, 'never', 'yes', coupleResolvable)
  return {
    ...base,
    questions: [{ question_id: `${personaId}_q`, text: 'q', expected_answer: 'a', answerable_by: answerableBy }],
  }
}

const APPROVAL_FREE = makeRequiredCategory('cat_inv', 'invitations', false)
const APPROVAL_REQUIRED = makeRequiredCategory('cat_venue', 'venue', true)

describe('Stage A/B couple sessions — honest claim equals trusted, genome-dependent', () => {
  it('a tier-2 genome charges a booking_approval session for the approval-required category only', () => {
    const scn = makeScenario('s_book_t2', [makeGuest('g_imm', 'immediate')], 'golden', [APPROVAL_FREE, APPROVAL_REQUIRED])
    const g = makeTier2Genome(2, 0, 1)
    expect(claimedSessions(g, scn)).toEqual(['booking_approval/cat_venue'])
    expect(trustedSessions(g, scn)).toEqual(['booking_approval/cat_venue'])
  })

  it('a tier-1 genome charges NO booking_approval session (it defers the approval-required category)', () => {
    const scn = makeScenario('s_book_t1', [makeGuest('g_imm', 'immediate')], 'golden', [APPROVAL_FREE, APPROVAL_REQUIRED])
    const g = makeGenome(2, 0)
    expect(claimedSessions(g, scn)).toEqual([])
    expect(trustedSessions(g, scn)).toEqual([])
  })

  it('a tier-2 genome charges a qa_escalation session for a requires_couple question only', () => {
    const scn = makeScenario('s_qa_t2', [guestWithQuestion('g_q', 'requires_couple')])
    const g = makeTier2Genome(2, 0, 1)
    // The guest is also couple-resolvable by default-false, so no RSVP escalation here — just the question.
    expect(claimedSessions(g, scn)).toEqual(['qa_escalation/g_q_q'])
    expect(trustedSessions(g, scn)).toEqual(['qa_escalation/g_q_q'])
  })

  it('an honest run reconciles with ZERO couple_session divergences across both tiers', () => {
    const scn = makeScenario('s_agree', [makeGuest('g_imm', 'immediate'), guestWithQuestion('g_q', 'requires_couple')], 'golden', [APPROVAL_FREE, APPROVAL_REQUIRED])
    for (const g of [makeGenome(2, 0), makeTier2Genome(2, 0, 1)]) {
      expect(claimedSessions(g, scn)).toEqual(trustedSessions(g, scn))
      const execution = run(g, scn)
      const divs = detectSelfReportDivergence(execution.productEvents, execution.recorder).filter(
        (d) => d.effect_kind === 'couple_session',
      )
      expect(divs).toEqual([])
    }
  })

  it('MULTI-REASON CO-PRESENT: rsvp + qa + booking sessions coexist at tier-2 without colliding (the composite key)', () => {
    // One scenario carrying ALL THREE reasons: an escalatable RSVP guest, a requires_couple question, and
    // an approval-required category. The OLD per-guest key could not represent this; the composite key
    // disambiguates, and the honest run reconciles clean.
    const rsvpGuest = makeGuest('g_relative', 'never', 'yes', true) // couple-resolvable ⇒ rsvp_escalation
    const qGuest = guestWithQuestion('g_q', 'requires_couple', false) // not couple-resolvable ⇒ only the question
    const scn = makeScenario('s_multi', [rsvpGuest, qGuest], 'golden', [APPROVAL_REQUIRED])
    const g = makeTier2Genome(2, 0, 3) // threshold 3 ⇒ escalate every pending couple-resolvable guest
    expect(claimedSessions(g, scn)).toEqual(['booking_approval/cat_venue', 'qa_escalation/g_q_q', 'rsvp_escalation/g_relative'])
    expect(trustedSessions(g, scn)).toEqual(claimedSessions(g, scn))
    const execution = run(g, scn)
    expect(detectSelfReportDivergence(execution.productEvents, execution.recorder)).toEqual([])
  })

  it('BYTE-IDENTITY: a category/question-free scenario emits ZERO new sessions and records ZERO', () => {
    const scn = makeScenario('s_none', [makeGuest('g_imm', 'immediate')]) // search-corpus shape
    for (const g of [makeGenome(2, 0), makeTier2Genome(2, 0, 1)]) {
      expect(claimedSessions(g, scn)).toEqual([])
      expect(trustedSessions(g, scn)).toEqual([])
    }
  })
})
