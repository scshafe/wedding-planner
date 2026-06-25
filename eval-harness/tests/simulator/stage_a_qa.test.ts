import { makePlannerSimulator, type ScenarioDefinition } from '@wedding-planner/eval-harness'
import { type GuestPersona } from '@wedding-planner/shared'
import { createMetricEngine, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import { makeGenome, makeGuest, makeScenario, makeTier2Genome, refFor } from './simulator_fixtures'

/**
 * Phase-7 Step 4: Stage A emits `guest.question.answered` per scripted question. The honest qa is
 * GENOME-DEPENDENT via the tier-2 autonomy_threshold: a `requires_couple` question is handled correctly
 * (escalated) only by a tier-2 genome; a tier-1 genome answers it (incorrect) → honest qa < 1.0. This
 * genome-dependence is exactly what makes the integrity firewall load-bearing (a tier-1 candidate
 * forging tier-2-grade handling is the keystone). Guests with no questions emit nothing (so the pinned
 * cube/oracle corpus, which is question-free, is byte-unchanged — pinned by the existing oracle suite).
 */

const BASE_TS = '2027-08-01T12:00:00.000Z'
const engine = createMetricEngine()

/** A guest carrying one scripted question of a given nature. */
function guestWithQuestion(
  personaId: string,
  answerableBy: GuestPersona['questions'][number]['answerable_by'],
): GuestPersona {
  const base = makeGuest(personaId, 'immediate', 'yes')
  return {
    ...base,
    questions: [
      {
        question_id: `${personaId}_q`,
        text: 'a scripted question',
        expected_answer: 'the truth',
        answerable_by: answerableBy,
      },
    ],
  }
}

function qaRate(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): number | null {
  const run = makePlannerSimulator({
    championGenome: genome,
    candidateGenome: genome,
    candidateArtifactRef: refFor(genome),
    baseTimestamp: BASE_TS,
  })
  const events = run(scenario, 'candidate').productEvents
  return engine.compute(METRIC_CODES.qa_accuracy_rate, events, scenario.scenario_id).value
}

describe('Stage A Q&A — honest handling is correct except tier-1 on requires_couple', () => {
  it('a tier-2 genome correctly ESCALATES a requires_couple question → qa 1.0', () => {
    const scn = makeScenario('s_qa_couple_t2', [guestWithQuestion('g_couple', 'requires_couple')])
    expect(qaRate(makeTier2Genome(2, 0, 1), scn)).toBe(1)
  })

  it('a tier-1 genome ANSWERS a requires_couple question (no escalation path) → qa 0.0', () => {
    const scn = makeScenario('s_qa_couple_t1', [guestWithQuestion('g_couple', 'requires_couple')])
    expect(qaRate(makeGenome(2, 0), scn)).toBe(0)
  })

  it('ai_from_known_facts and must_refuse are handled correctly at BOTH tiers → qa 1.0', () => {
    const scn = makeScenario('s_qa_tierfree', [
      guestWithQuestion('g_ai', 'ai_from_known_facts'),
      guestWithQuestion('g_refuse', 'must_refuse'),
    ])
    expect(qaRate(makeGenome(2, 0), scn)).toBe(1) // tier-1
    expect(qaRate(makeTier2Genome(2, 0, 1), scn)).toBe(1) // tier-2
  })

  it('a question-free scenario yields a null qa rate (honest-undefined), emitting no answered events', () => {
    const scn = makeScenario('s_qa_none', [makeGuest('g_plain', 'immediate', 'yes')])
    expect(qaRate(makeGenome(2, 0), scn)).toBeNull()
  })
})
