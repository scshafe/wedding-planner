import { readFileSync } from 'node:fs'

import {
  checkIntegritySelfReportDivergence,
  GenomeArtifactRefMismatchError,
  makePlannerSimulator,
  type Planner,
  rsvpCadencePlanner,
} from '@wedding-planner/eval-harness'
import { type EventEnvelope, resolveFromRepoRoot } from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import { makeGenome, makeScenario, refFor } from './simulator_fixtures'

/**
 * Step 3: the two-stage planner simulator. These tests pin determinism/replay, cross-scenario id
 * disjointness, the content-address enforcement, and — the load-bearing one — that Stage B is
 * INDEPENDENT of Stage A so INTEGRITY.SELF_REPORT_DIVERGENCE stays non-vacuous. The metamorphic /
 * anti-no-op ORACLE lives in metamorphic_oracle.test.ts (Step 4).
 */

const BASE_TS = '2027-03-01T12:00:00.000Z'

function simulatorFor(championCadence: number, candidateCadence: number, planner?: Planner) {
  const championGenome = makeGenome(championCadence)
  const candidateGenome = makeGenome(candidateCadence)
  return makePlannerSimulator({
    championGenome,
    candidateGenome,
    candidateArtifactRef: refFor(candidateGenome),
    baseTimestamp: BASE_TS,
    ...(planner === undefined ? {} : { planner }),
  })
}

describe('planner simulator — determinism & replay', () => {
  it('replays byte-identically for the same (scenario, variant)', () => {
    const run = simulatorFor(0, 2)
    const scenario = makeScenario('s_replay')
    const a = run(scenario, 'candidate')
    const b = run(scenario, 'candidate')
    expect(JSON.stringify(a.productEvents)).toBe(JSON.stringify(b.productEvents))
  })

  it('namespaces event ids so two scenarios in one pass never collide', () => {
    const run = simulatorFor(0, 2)
    const idsOf = (events: readonly EventEnvelope[]): Set<string> =>
      new Set(events.map((event) => event.event_id))
    const s1 = run(makeScenario('s_one'), 'candidate').productEvents
    const s2 = run(makeScenario('s_two'), 'candidate').productEvents
    const ids1 = idsOf(s1)
    const ids2 = idsOf(s2)
    expect(ids1.size).toBe(s1.length)
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false)
    }
  })

  it('baseline vs candidate variant use the champion vs candidate genome (different streams)', () => {
    const run = simulatorFor(0, 3)
    const scenario = makeScenario('s_variant')
    const baseline = run(scenario, 'baseline').productEvents
    const candidate = run(scenario, 'candidate').productEvents
    // The candidate (cadence 3) emits strictly more reminder events than the champion (cadence 0).
    const reminders = (events: readonly EventEnvelope[]): number =>
      events.filter((event) => event.event_name === EVENT_NAMES.guest_rsvp_reminded).length
    expect(reminders(candidate)).toBeGreaterThan(reminders(baseline))
  })
})

describe('planner simulator — content-address enforcement (validate -> verify-ref, refuse-and-halt)', () => {
  it('runs when the candidate genome matches its committed artifact_ref', () => {
    expect(() => simulatorFor(0, 1)).not.toThrow()
  })

  it('refuses a substituted genome (mismatch) with a distinct coded error', () => {
    const championGenome = makeGenome(0)
    const candidateGenome = makeGenome(1)
    try {
      makePlannerSimulator({
        championGenome,
        candidateGenome,
        candidateArtifactRef: refFor(makeGenome(2)), // committed to a DIFFERENT genome
        baseTimestamp: BASE_TS,
      })
      throw new Error('expected a mismatch throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GenomeArtifactRefMismatchError)
      expect((error as GenomeArtifactRefMismatchError).code).toBe('SIMULATOR.GENOME_REF_MISMATCH')
    }
  })

  it('refuses a malformed (non-genome) artifact_ref distinctly from a mismatch', () => {
    const candidateGenome = makeGenome(1)
    try {
      makePlannerSimulator({
        championGenome: makeGenome(0),
        candidateGenome,
        candidateArtifactRef: 'branch:not-a-genome',
        baseTimestamp: BASE_TS,
      })
      throw new Error('expected a malformed throw')
    } catch (error) {
      expect((error as GenomeArtifactRefMismatchError).code).toBe('SIMULATOR.GENOME_REF_MALFORMED')
    }
  })

  it('validates genomes first: an invalid champion genome throws before any run', () => {
    const candidateGenome = makeGenome(1)
    expect(() =>
      makePlannerSimulator({
        championGenome: { genome_id: 'bad', parameters: { rsvp_reminder_cadence: 99, reminder_spacing: 0, reminder_batching: 0 } },
        candidateGenome,
        candidateArtifactRef: refFor(candidateGenome),
        baseTimestamp: BASE_TS,
      }),
    ).toThrow()
  })
})

describe('planner simulator — Stage A / Stage B independence keeps INTEGRITY non-vacuous', () => {
  it('an honest run produces no self-report divergence', () => {
    const run = simulatorFor(0, 2)
    const execution = run(makeScenario('s_honest'), 'candidate')
    execution.recorder.seal()
    const gate = checkIntegritySelfReportDivergence(execution.productEvents, execution.recorder)
    expect(gate.passed).toBe(true)
  })

  it('a LYING Stage A (forged commitment) is caught — Stage B did not corroborate it', () => {
    // The whole point of the stage split: inject a planner that claims a commitment effect Stage B
    // never observed. If Stage B echoed Stage A, the gate would be blind. It is not.
    const lyingPlanner: Planner = ({ scenario, clock, ids }) => {
      const honest = rsvpCadencePlanner({ scenario, genome: makeGenome(1), clock, ids })
      const forged: EventEnvelope = buildEvent(clock, ids, {
        event_name: EVENT_NAMES.commitment_executed,
        trace_id: `t_${scenario.scenario_id}`,
        wedding_id: scenario.scenario_id,
        phase: 'booking',
        capability: 'budget_management',
        actor: 'ai',
        source: 'eval',
        payload: { commitment_id: 'forged_c1', verified: true, cost_cents: 500000 },
        meta: { schema_version: '1.0.0' },
      })
      return [...honest, forged]
    }
    const run = simulatorFor(0, 1, lyingPlanner)
    const execution = run(makeScenario('s_lie'), 'candidate')
    execution.recorder.seal()
    const gate = checkIntegritySelfReportDivergence(execution.productEvents, execution.recorder)
    expect(gate.passed).toBe(false)
    expect(gate.evidence.join(' ')).toContain('forged_c1')
  })
})

describe('planner simulator — no ambient nondeterminism', () => {
  it('the simulator sources never reference Date.now / Math.random / argless new Date()', () => {
    const files = [
      'eval-harness/src/simulator/stage_a_planner.ts',
      'eval-harness/src/simulator/stage_b_observer.ts',
      'eval-harness/src/simulator/planner_simulator.ts',
    ]
    for (const file of files) {
      const src = readFileSync(resolveFromRepoRoot(file), 'utf8')
      expect(src, `${file} uses Date.now`).not.toMatch(/Date\.now/)
      expect(src, `${file} uses Math.random`).not.toMatch(/Math\.random/)
      expect(src, `${file} uses argless new Date()`).not.toMatch(/new Date\(\s*\)/)
    }
  })
})
