import {
  guardSpecsFor,
  loadCouplePersona,
  type ProductRunner,
  type ScenarioDefinition,
  scoreCandidateOffline,
  TrustedRecorder,
} from '@wedding-planner/eval-harness'
import {
  DECIDED_BY,
  HmacTransitionSigner,
  Ledger,
  runOfflineSelection,
  STAGES,
  verifyLedgerChain,
} from '@wedding-planner/loop-orchestrator'
import { type CandidateChange, type EventEnvelope, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, createMetricEngine, EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Step 10 integration test: one candidate through the whole offline path —
 * trusted recorder -> veto gates -> North Star scoring -> accept rule -> ledger — asserting the
 * chained ledger entry and the offline_result payload.
 */

const couple = loadCouplePersona('couple_standard_baseline')

const CORPUS: ScenarioDefinition[] = [
  { scenario_id: 'golden_g1', scenario_type: 'golden', couple, guests: [], bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.9 }] },
  { scenario_id: 'adversarial_a1', scenario_type: 'adversarial', couple, guests: [], bookedPlanFacts: {}, targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.9 }] },
]

/**
 * A Phase-1 sandbox stub. Both variants satisfy the couple's hard constraints and make no
 * commitments/sends (so the veto gates hold). The candidate resolves one more RSVP than the baseline
 * on every scenario, so rsvp_resolution_rate (and the North Star) rise — unless `improve` is false,
 * in which case the candidate behaves identically (no improvement -> rejected).
 */
function makeRunner(improve: boolean): ProductRunner {
  return (scenario, variant) => {
    const recorder = new TrustedRecorder()
    for (const hardConstraint of scenario.couple.hard_constraints) {
      recorder.recordConstraintDetermination({
        constraint_id: hardConstraint.constraint_id,
        constraint_type: hardConstraint.type,
        satisfied: true,
        severity: (hardConstraint.severity as 'fatal' | 'serious' | 'moderate' | undefined) ?? 'serious',
        plan_element_ref: null,
      })
    }
    const clock = new ManualClock('2027-01-02T15:00:00.000Z')
    const ids = new SequentialIdGenerator(`${scenario.scenario_id}_${variant}`)
    const events: EventEnvelope[] = []
    const emit = (eventName: string, payload: Record<string, unknown>, guestId: string): void => {
      events.push(
        buildEvent(clock, ids, {
          event_name: eventName,
          trace_id: `t_${scenario.scenario_id}`,
          wedding_id: scenario.scenario_id,
          phase: 'rsvp_window',
          capability: 'rsvp',
          actor: eventName === EVENT_NAMES.guest_rsvp_received ? 'guest' : 'ai',
          source: 'eval',
          guest_id: guestId,
          payload,
          meta: { schema_version: '1.0.0' },
        }),
      )
      clock.advance(1000)
    }
    for (const guest of ['g1', 'g2', 'g3']) {
      emit(EVENT_NAMES.guest_rsvp_requested, { guest_id: guest }, guest)
    }
    emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g1', rsvp_status: 'yes' }, 'g1')
    emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g2', rsvp_status: 'no' }, 'g2')
    if (improve && variant === 'candidate') {
      emit(EVENT_NAMES.guest_rsvp_received, { guest_id: 'g3', rsvp_status: 'yes' }, 'g3')
    }
    return { recorder, productEvents: events }
  }
}

function candidateChange(): CandidateChange {
  return {
    candidate_id: 'cand_rsvp_1',
    created_at: '2027-01-02T15:00:00Z',
    author: 'ai_proposer',
    hypothesis: {
      target_capability: 'rsvp',
      target_metric_code: 'rsvp_resolution_rate',
      target_scenario_ids: ['adversarial_a1'],
      expected_direction: 'increase',
      guards_to_watch: ['rsvp_resolution_rate'],
      rationale: 'A second reminder lifts resolution on the hard case.',
    },
    change: {
      change_type: 'flow',
      summary: 'Add a second RSVP reminder.',
      artifact_ref: 'branch:rsvp/second-reminder@abc',
      reversible: true,
      capabilities_touched: ['rsvp'],
      mid_engagement_safe: true,
    },
    risk_tier: 1,
    status: 'implemented',
  }
}

function makeLedger(): Ledger {
  return new Ledger(
    new ManualClock('2027-01-02T16:00:00.000Z'),
    new SequentialIdGenerator('seedPipeline'),
    new HmacTransitionSigner('phase1-key'),
  )
}

function score(improve: boolean): ReturnType<typeof scoreCandidateOffline> {
  return scoreCandidateOffline({
    corpus: CORPUS,
    runner: makeRunner(improve),
    guards: guardSpecsFor(['rsvp_resolution_rate']),
    metricEngine: createMetricEngine(),
    clock: new ManualClock('2027-01-02T15:30:00.000Z'),
    ids: new SequentialIdGenerator('seedRun'),
    harnessVersion: 'h1',
    seed: 's1',
  })
}

function seedProposedToImplemented(ledger: Ledger, candidateId: string): void {
  ledger.append({
    candidate_id: candidateId,
    from_state: STAGES.proposed,
    to_state: STAGES.implemented,
    decided_by: DECIDED_BY.ai_proposer,
    rationale: 'proposer implemented the candidate in an isolated worktree',
  })
}

describe('offline pipeline — end to end', () => {
  it('runs an improving candidate to offline_passed with a chained ledger + offline_result', () => {
    const candidate = candidateChange()
    const ledger = makeLedger()
    seedProposedToImplemented(ledger, candidate.candidate_id)

    const result = runOfflineSelection(candidate, score(true), ledger)

    expect(result.accepted).toBe(true)

    // The chained ledger: proposed->implemented (ai_proposer), then the selector's two transitions.
    const entry = result.ledgerEntry
    expect(entry.state_transitions.map((t) => t.to_state)).toEqual([
      STAGES.implemented,
      STAGES.offline_scoring,
      STAGES.offline_passed,
    ])
    expect(entry.state_transitions[1]?.decided_by).toBe(DECIDED_BY.deterministic_selector)
    expect(entry.state_transitions[2]?.decided_by).toBe(DECIDED_BY.deterministic_selector)
    expect(verifyLedgerChain(entry)).toEqual({ valid: true })
    expect(entry.final_disposition).toBeNull() // offline_passed is not terminal

    // The offline_result payload.
    expect(result.offlineResult.aggregate_north_star_delta).toBeGreaterThan(0)
    expect(result.offlineResult.golden_regressed).toBe(false)
    expect(result.offlineResult.new_gate_failures).toEqual([])
    expect(result.offlineResult.hypothesis_confirmed).toBe(true)
    expect(result.offlineResult.observed_target_delta).toBeGreaterThan(0)
    expect(result.offlineResult.target_attribution_share).toBeGreaterThan(0)
    expect(result.offlineResult.grade_report_refs?.length).toBe(CORPUS.length)
  })

  it('rejects a non-improving candidate to offline_rejected with a lesson', () => {
    const candidate = candidateChange()
    const ledger = makeLedger()
    seedProposedToImplemented(ledger, candidate.candidate_id)

    const result = runOfflineSelection(candidate, score(false), ledger)

    expect(result.accepted).toBe(false)
    const entry = result.ledgerEntry
    expect(entry.state_transitions.at(-1)?.to_state).toBe(STAGES.offline_rejected)
    expect(entry.final_disposition).toBe('rejected_offline')
    expect(entry.lessons?.length ?? 0).toBeGreaterThan(0)
    expect(verifyLedgerChain(entry)).toEqual({ valid: true })
  })
})
