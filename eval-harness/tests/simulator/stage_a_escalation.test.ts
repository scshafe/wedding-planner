import { genomeArtifactRef } from '@wedding-planner/shared'
import { createMetricEngine, EVENT_NAMES, METRIC_CODES } from '@wedding-planner/telemetry'
import { makePlannerSimulator, runVetoGates } from '@wedding-planner/eval-harness'
import { describe, expect, it } from 'vitest'

import { makeGenome, makeGuest, makeScenario, makeTier2Genome } from './simulator_fixtures'

/**
 * Phase-4b Step 4: Stage A's escalate-to-couple behavior (the forge surface) is now fully guarded by
 * the Step-3 firewall. These tests pin that HONEST escalation (a) passes the integrity gate, (b) lifts
 * the resolution numerator AND the couple-cost denominator (the real value/cost tradeoff), and (c) a
 * tier-1 genome (no autonomy_threshold) emits ZERO escalation — the search box never exercises this.
 */

const BASE_TS = '2026-03-01T00:00:00.000Z'

// One immediate responder (reminder-resolved) + one never-responder the COUPLE can resolve.
const guests = [
  makeGuest('g_immediate', 'immediate', 'yes'),
  makeGuest('g_relative', 'never', 'yes', true),
]
const scenario = makeScenario('s_escalation', guests)
const engine = createMetricEngine()

function run(genome: ReturnType<typeof makeGenome>): {
  integrityPassed: boolean
  resolutionRate: number | null
  coupleMinutes: number | null
  coupleSessionEvents: number
} {
  const runner = makePlannerSimulator({
    championGenome: genome,
    candidateGenome: genome,
    candidateArtifactRef: genomeArtifactRef(genome),
    baseTimestamp: BASE_TS,
  })
  const { recorder, productEvents } = runner(scenario, 'candidate')
  recorder.seal()
  const gateRun = runVetoGates({
    recorder,
    productEvents,
    couple: scenario.couple,
    guests: scenario.guests,
    bookedPlanFacts: scenario.bookedPlanFacts,
  })
  const integrity = gateRun.results.find((r) => r.gate_code.includes('INTEGRITY'))
  const comps = engine.computeMany(engine.metricCodes(), productEvents, scenario.scenario_id)
  const value = (code: string): number | null => comps.find((c) => c.metric_code === code)?.value ?? null
  return {
    integrityPassed: integrity?.passed ?? false,
    resolutionRate: value(METRIC_CODES.rsvp_resolution_rate),
    coupleMinutes: value(METRIC_CODES.couple_active_minutes_total),
    coupleSessionEvents: productEvents.filter((e) => e.event_name === EVENT_NAMES.couple_session_ended).length,
  }
}

describe('Stage A — honest escalate-to-couple under the firewall', () => {
  it('a tier-1 genome (no autonomy_threshold) emits ZERO escalation and resolves only by reminders', () => {
    const tier1 = run(makeGenome(1, 0))
    expect(tier1.integrityPassed).toBe(true)
    expect(tier1.coupleSessionEvents).toBe(0)
    expect(tier1.resolutionRate).toBe(0.5) // only g_immediate; g_relative never responds to reminders
    expect(tier1.coupleMinutes).toBe(0)
  })

  it('an HONEST escalating tier-2 genome PASSES integrity and lifts resolution AND couple cost', () => {
    const tier1 = run(makeGenome(1, 0))
    const tier2 = run(makeTier2Genome(1, 0, 1))

    expect(tier2.integrityPassed).toBe(true) // honest claims match the trusted record
    expect(tier2.coupleSessionEvents).toBe(1) // the couple resolved g_relative
    // Value up: g_relative now resolves via the couple → resolution numerator rises.
    expect(tier2.resolutionRate as number).toBeGreaterThan(tier1.resolutionRate as number)
    expect(tier2.resolutionRate).toBe(1)
    // Cost up: the escalation consumed couple attention → effort_cost denominator rises.
    expect(tier2.coupleMinutes as number).toBeGreaterThan(tier1.coupleMinutes as number)
  })
})
