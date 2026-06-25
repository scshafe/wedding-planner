import {
  computeNorthStar,
  deriveNorthStarInputs,
  detectSelfReportDivergence,
  makePlannerSimulator,
  type ScenarioDefinition,
} from '@wedding-planner/eval-harness'
import { createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import {
  makeGenome,
  makeRequiredCategory,
  makeScenario,
  makeTier2Genome,
  refFor,
} from '../simulator/simulator_fixtures'

/**
 * Phase-10 Step 6: the honest-run audit + read-seam for the vision/quality capstone.
 *  (b) over {vision-sensitive × tier-1/tier-2} an HONEST run reconciles clean (Stage A ≡ Stage B) — a stage
 *      divergence would self-veto every honest vision run and make the gate false-positive.
 *  (c) a MULTI-SURFACE co-present scenario (a tier-2 category that is BOTH requires_couple_approval AND
 *      vision_sensitive) reconciles clean — the completeness + quality value surfaces, and the
 *      booking_approval + vision_consult cost reasons, all compose under Phase 9's per-(reason, about_id) key.
 *  (d) read-seam: the vision_match_rate metric reader and the integrity gate reader agree on an honest
 *      vision-bearing stream; `quality` is computed (non-null) and flows into planning_value.
 */

const BASE_TS = '2027-10-15T12:00:00.000Z'
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

const VISION_FREE_APPROVAL_FREE = makeRequiredCategory('cat_decor', 'decor', false, true)

describe('Phase-10 honest-run audit — no self-veto on honest vision runs', () => {
  it('(b) every {vision-sensitive × tier} honest run reconciles clean (zero divergences)', () => {
    const scn = makeScenario('s_audit', undefined, 'golden', [VISION_FREE_APPROVAL_FREE])
    for (const g of [makeGenome(2, 0), makeTier2Genome(2, 0, 1)]) {
      const exec = run(g, scn)
      const divs = detectSelfReportDivergence(exec.productEvents, exec.recorder)
      expect(divs).toEqual([]) // honest Stage A claims === Stage B trusted record on BOTH tiers
    }
  })

  it('(c) MULTI-SURFACE co-present: a tier-2 approval-required + vision-sensitive category reconciles clean', () => {
    // One category drives all four surfaces at tier-2: category.booked (completeness), category.vision.aligned
    // (quality), a booking_approval couple session AND a vision_consult couple session — distinct composite
    // keys (booking_approval/cat) vs (vision_consult/cat) under Phase 9's per-(reason, about_id) reconciliation.
    const scn = makeScenario('s_multi', undefined, 'golden', [makeRequiredCategory('cat_venue', 'venue', true, true)])
    const exec = run(makeTier2Genome(2, 0, 1), scn)
    expect(detectSelfReportDivergence(exec.productEvents, exec.recorder)).toEqual([])

    // Positively: all four honest surfaces are present.
    const names = exec.productEvents.map((e) => e.event_name)
    expect(names).toContain(EVENT_NAMES.category_booked)
    expect(names).toContain(EVENT_NAMES.category_vision_aligned)
    const reasons = exec.productEvents
      .filter((e) => e.event_name === EVENT_NAMES.couple_session_ended)
      .map((e) => (e.payload as { session_reason: string }).session_reason)
    expect(reasons).toContain('booking_approval')
    expect(reasons).toContain('vision_consult')
    // The two sessions are recorded under distinct composite keys (no collision).
    expect(exec.recorder.coupleSession('booking_approval', 'cat_venue')).toBeDefined()
    expect(exec.recorder.coupleSession('vision_consult', 'cat_venue')).toBeDefined()
  })

  it('(d) read-seam: metric vision_match_rate matches the gate-clean trusted alignment; quality is computed', () => {
    const scn = makeScenario('s_seam', undefined, 'golden', [VISION_FREE_APPROVAL_FREE])
    const tier2 = run(makeTier2Genome(2, 0, 1), scn)
    const tier1 = run(makeGenome(2, 0), scn)

    // Metric reader: tier-2 aligns (1.0), tier-1 defaults (0.5); both gate-clean (no vision divergence).
    const rate = (exec: ReturnType<typeof run>): number | null =>
      engine.compute(METRIC_CODES.vision_match_rate, exec.productEvents, scn.scenario_id).value
    expect(rate(tier2)).toBe(1)
    expect(rate(tier1)).toBe(0.5)
    for (const exec of [tier1, tier2]) {
      expect(detectSelfReportDivergence(exec.productEvents, exec.recorder).filter((d) => d.effect_kind === 'vision_alignment')).toEqual([])
    }

    // quality flows into planning_value (non-null now) and tracks the vision rate.
    const inputs = (exec: ReturnType<typeof run>) => {
      const values: Record<string, number | null> = {}
      for (const c of engine.computeMany(engine.metricCodes(), exec.productEvents, scn.scenario_id)) {
        values[c.metric_code] = c.value
      }
      return deriveNorthStarInputs(values, scn.couple)
    }
    expect(inputs(tier2).quality).toBe(1)
    expect(inputs(tier1).quality).toBe(0.5)
    // A higher vision_match (tier-2, holding the rest) yields a higher planning_value → the value lever is live.
    expect(computeNorthStar(inputs(tier2), false).planning_value).toBeGreaterThan(
      computeNorthStar(inputs(tier1), false).planning_value,
    )
  })
})
