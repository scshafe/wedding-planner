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
 * Phase-8 Step 5: Stage A emits one `category.booked` per required category; Stage B records the trusted
 * booking from the SHARED `honestCategoryStatus` fact. The honest status is GENOME-DEPENDENT via the
 * tier-2 autonomy_threshold: an approval-required category is `booked` only by a tier-2 genome; a tier-1
 * genome `deferred`s it → completeness < 1.0. Honest claims MUST equal the trusted record (the integrity
 * gate field-diffs them with `===`). A category-FREE scenario (the search corpus) emits ZERO category
 * events and records ZERO trusted bookings — the byte-identity guarantee that keeps the cube pins intact.
 */

const BASE_TS = '2027-08-01T12:00:00.000Z'
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

function categoryRate(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): number | null {
  return engine.compute(METRIC_CODES.category_completeness_rate, run(genome, scenario).productEvents, scenario.scenario_id)
    .value
}

/** The booking_status the product CLAIMED per category_id (Stage A). */
function claimedStatuses(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): Record<string, string> {
  const out: Record<string, string> = {}
  for (const event of run(genome, scenario).productEvents) {
    if (event.event_name === EVENT_NAMES.category_booked) {
      const p = event.payload as { category_id: string; booking_status: string }
      out[p.category_id] = p.booking_status
    }
  }
  return out
}

/** The booking_status the harness RECORDED per category_id (Stage B trusted record). */
function trustedStatuses(genome: ReturnType<typeof makeGenome>, scenario: ScenarioDefinition): Record<string, string> {
  const out: Record<string, string> = {}
  for (const record of run(genome, scenario).recorder.allCategoryBookings()) {
    out[record.category_id] = record.booking_status
  }
  return out
}

const APPROVAL_FREE = makeRequiredCategory('cat_invitations', 'invitations', false)
const APPROVAL_REQUIRED = makeRequiredCategory('cat_venue', 'venue', true)

describe('Stage A/B category bookings — honest claim equals trusted, genome-dependent', () => {
  it('a tier-2 genome BOOKS both an approval-free and an approval-required category → completeness 1.0', () => {
    const scn = makeScenario('s_cat_t2', undefined, 'golden', [APPROVAL_FREE, APPROVAL_REQUIRED])
    const g = makeTier2Genome(2, 0, 1)
    expect(categoryRate(g, scn)).toBe(1)
    expect(claimedStatuses(g, scn)).toEqual({ cat_invitations: 'booked', cat_venue: 'booked' })
  })

  it('a tier-1 genome DEFERS the approval-required category → completeness 0.5', () => {
    const scn = makeScenario('s_cat_t1', undefined, 'golden', [APPROVAL_FREE, APPROVAL_REQUIRED])
    const g = makeGenome(2, 0)
    expect(categoryRate(g, scn)).toBe(0.5)
    expect(claimedStatuses(g, scn)).toEqual({ cat_invitations: 'booked', cat_venue: 'deferred' })
  })

  it('Stage A claim equals Stage B trusted record across both tiers (the integrity-gate diff is safe)', () => {
    const scn = makeScenario('s_cat_agree', undefined, 'golden', [APPROVAL_FREE, APPROVAL_REQUIRED])
    for (const g of [makeGenome(2, 0), makeTier2Genome(2, 0, 1)]) {
      expect(claimedStatuses(g, scn)).toEqual(trustedStatuses(g, scn))
    }
  })

  it('BYTE-IDENTITY: a category-free scenario emits ZERO category events and records ZERO bookings', () => {
    const scn = makeScenario('s_cat_none') // no required_categories (the search corpus)
    const g = makeGenome(2, 0)
    const execution = run(g, scn)
    expect(execution.productEvents.filter((e) => e.event_name === EVENT_NAMES.category_booked)).toHaveLength(0)
    expect(execution.recorder.allCategoryBookings()).toHaveLength(0)
    expect(categoryRate(g, scn)).toBeNull()
  })
})
