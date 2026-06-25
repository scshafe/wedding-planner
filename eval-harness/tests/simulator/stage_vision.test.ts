import { makePlannerSimulator, type ScenarioDefinition } from '@wedding-planner/eval-harness'
import { createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import {
  makeGenome,
  makeRequiredCategory,
  makeScenario,
  makeTier2Genome,
  refFor,
} from './simulator_fixtures'

/**
 * Phase-10 Step 4: Stage A emits one `category.vision.aligned` per BOOKED, vision-sensitive category (and a
 * `vision_consult` couple session when it consults); Stage B records the trusted alignment + session from
 * the SHARED `honestVisionMatch` / `honestVisionConsultSession` facts. The honest score is GENOME-DEPENDENT
 * via the tier-2 consult capability: a tier-2 genome ALIGNS (1.0) AND pays a vision_consult session; a
 * tier-1 genome books a DEFAULT (0.5) selection at no cost. It is ORTHOGONAL to completeness (the category
 * is booked either way). Honest claims MUST equal the trusted record (the gate field-diffs with `===`). A
 * vision-FREE scenario (the search corpus) AND a non-vision-sensitive category emit ZERO vision events — the
 * byte-identity guarantee that keeps the cube pins + the Phase-8 keystone intact.
 */

const BASE_TS = '2027-09-01T12:00:00.000Z'
const engine = createMetricEngine()

function run(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition) {
  const sim = makePlannerSimulator({
    championGenome: genome,
    candidateGenome: genome,
    candidateArtifactRef: refFor(genome),
    baseTimestamp: BASE_TS,
  })
  return sim(scenario, 'candidate')
}

function visionRate(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): number | null {
  return engine.compute(METRIC_CODES.vision_match_rate, run(genome, scenario).productEvents, scenario.scenario_id).value
}

/** The vision_match_score the product CLAIMED per category_id (Stage A). */
function claimedScores(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): Record<string, number> {
  const out: Record<string, number> = {}
  for (const event of run(genome, scenario).productEvents) {
    if (event.event_name === EVENT_NAMES.category_vision_aligned) {
      const p = event.payload as { category_id: string; vision_match_score: number }
      out[p.category_id] = p.vision_match_score
    }
  }
  return out
}

/** The vision_match_score the harness RECORDED per category_id (Stage B trusted record). */
function trustedScores(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): Record<string, number> {
  const out: Record<string, number> = {}
  for (const record of run(genome, scenario).recorder.allVisionAlignments()) {
    out[record.category_id] = record.vision_match_score
  }
  return out
}

/** vision_consult couple sessions the product claimed (Stage A), by about_id. */
function visionConsultSessions(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): string[] {
  return run(genome, scenario)
    .productEvents.filter((e) => e.event_name === EVENT_NAMES.couple_session_ended)
    .map((e) => e.payload as { session_reason: string; about_id: string })
    .filter((p) => p.session_reason === 'vision_consult')
    .map((p) => p.about_id)
}

// approval-free + vision-sensitive: booked at any tier, vision is the ONLY tier-dependent axis (the cleanest shape).
const VISION_CAT = makeRequiredCategory('cat_decor', 'decor', false, true)

describe('Stage A/B vision alignment — honest claim equals trusted, genome-dependent, orthogonal to completeness', () => {
  it('a tier-2 genome ALIGNS the vision-sensitive category (1.0) AND pays one vision_consult session', () => {
    const scn = makeScenario('s_vis_t2', undefined, 'golden', [VISION_CAT])
    const g = makeTier2Genome(2, 0, 1)
    expect(visionRate(g, scn)).toBe(1)
    expect(claimedScores(g, scn)).toEqual({ cat_decor: 1 })
    expect(visionConsultSessions(g, scn)).toEqual(['cat_decor'])
  })

  it('a tier-1 genome books a DEFAULT (0.5) selection and pays NO vision_consult session', () => {
    const scn = makeScenario('s_vis_t1', undefined, 'golden', [VISION_CAT])
    const g = makeGenome(2, 0)
    expect(visionRate(g, scn)).toBe(0.5)
    expect(claimedScores(g, scn)).toEqual({ cat_decor: 0.5 })
    expect(visionConsultSessions(g, scn)).toEqual([])
  })

  it('Stage A claim equals Stage B trusted record across both tiers (the integrity-gate diff is safe)', () => {
    const scn = makeScenario('s_vis_agree', undefined, 'golden', [VISION_CAT])
    for (const g of [makeGenome(2, 0), makeTier2Genome(2, 0, 1)]) {
      expect(claimedScores(g, scn)).toEqual(trustedScores(g, scn))
    }
  })

  it('a vision-sensitive but DEFERRED category (tier-1, approval-required) emits NO vision claim (not booked)', () => {
    // approval-required + vision-sensitive: a tier-1 genome DEFERS it → no selection → no vision claim.
    const scn = makeScenario('s_vis_deferred', undefined, 'golden', [makeRequiredCategory('cat_venue', 'venue', true, true)])
    const g = makeGenome(2, 0)
    expect(claimedScores(g, scn)).toEqual({})
    expect(trustedScores(g, scn)).toEqual({})
    expect(visionRate(g, scn)).toBeNull()
  })

  it('BYTE-IDENTITY: a NON-vision-sensitive category (every search/Phase-8 category) emits ZERO vision events', () => {
    const scn = makeScenario('s_vis_plain', undefined, 'golden', [makeRequiredCategory('cat_inv', 'invitations', false)])
    for (const g of [makeGenome(2, 0), makeTier2Genome(2, 0, 1)]) {
      const exec = run(g, scn)
      expect(exec.productEvents.filter((e) => e.event_name === EVENT_NAMES.category_vision_aligned)).toHaveLength(0)
      expect(exec.recorder.allVisionAlignments()).toHaveLength(0)
      expect(visionConsultSessions(g, scn)).toEqual([])
      expect(visionRate(g, scn)).toBeNull()
    }
  })

  it('BYTE-IDENTITY: a category-free scenario (the search corpus) emits ZERO vision events, rate null', () => {
    const scn = makeScenario('s_vis_none')
    const g = makeTier2Genome(2, 0, 1)
    const exec = run(g, scn)
    expect(exec.productEvents.filter((e) => e.event_name === EVENT_NAMES.category_vision_aligned)).toHaveLength(0)
    expect(exec.recorder.allVisionAlignments()).toHaveLength(0)
    expect(visionRate(g, scn)).toBeNull()
  })
})
