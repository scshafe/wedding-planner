import {
  guardSpecsFor,
  type OfflineScoreResult,
  scoreCandidateOffline,
} from '@wedding-planner/eval-harness'
import {
  HmacTransitionSigner,
  Ledger,
  runOfflineLoop,
  StubProposer,
  verifyLedgerChain,
} from '@wedding-planner/loop-orchestrator'
import { type CandidateChange, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { createMetricEngine } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

import { makeRsvpRunner, RSVP_CORPUS } from '../fixtures/rsvp_corpus'

/**
 * Step 11 integration test: the offline loop drives propose -> score -> ledger -> learn on a trivial
 * corpus and terminates loop-until-dry. The first proposed candidate improves (accepted); the rest do
 * not (rejected), so after K=2 consecutive non-passing iterations the search goes dry and the loop
 * stops.
 */

function makeLedger(): Ledger {
  return new Ledger(
    new ManualClock('2027-01-02T16:00:00.000Z'),
    new SequentialIdGenerator('seedLoop'),
    new HmacTransitionSigner('phase1-key'),
  )
}

function makeProposer(): StubProposer {
  return new StubProposer(
    new ManualClock('2027-01-02T15:00:00.000Z'),
    new SequentialIdGenerator('seedProposer'),
    {
      target_capability: 'rsvp',
      target_metric_code: 'rsvp_resolution_rate',
      expected_direction: 'increase',
      guards_to_watch: ['rsvp_resolution_rate'],
      target_scenario_ids: ['adversarial_a1'],
      change_type: 'flow',
    },
  )
}

/**
 * Score the corpus for real (scoreCandidateOffline + the veto gates + the accept rule), but make only
 * the FIRST candidate improve, so subsequent iterations reject and the loop goes dry.
 */
function makeScorer(): (candidate: CandidateChange) => OfflineScoreResult {
  let callCount = 0
  return (_candidate) => {
    const improve = callCount === 0
    callCount += 1
    return scoreCandidateOffline({
      corpus: RSVP_CORPUS,
      runner: makeRsvpRunner(improve),
      guards: guardSpecsFor(['rsvp_resolution_rate']),
      metricEngine: createMetricEngine(),
      clock: new ManualClock('2027-01-02T15:30:00.000Z'),
      ids: new SequentialIdGenerator(`run_${callCount}`),
      harnessVersion: 'h1',
    })
  }
}

describe('offline loop — propose -> score -> ledger -> learn, loop-until-dry', () => {
  it('accepts the improving candidate, then terminates dry after K non-passing iterations', () => {
    const ledger = makeLedger()
    const summary = runOfflineLoop({
      proposer: makeProposer(),
      scoreCandidate: makeScorer(),
      ledger,
      clock: new ManualClock('2027-01-02T16:00:00.000Z'),
      ids: new SequentialIdGenerator('seedLoopCtl'),
      maxDryIterations: 2,
    })

    expect(summary.terminatedReason).toBe('dry')
    expect(summary.accepted).toBe(1)
    expect(summary.rejected).toBe(2) // K = 2 consecutive non-passing -> dry
    expect(summary.iterations).toBe(3)
    expect(summary.acceptedCandidateIds).toHaveLength(1)

    // Every proposed candidate has a ledger entry, and every chain is intact.
    const entries = ledger.allEntries()
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      expect(verifyLedgerChain(entry)).toEqual({ valid: true })
      // proposed -> implemented (ai_proposer) is the first transition of each candidate.
      expect(entry.state_transitions[0]?.decided_by).toBe('ai_proposer')
    }

    // The accepted candidate reached offline_passed; the rejected ones reached offline_rejected.
    const passed = entries.filter((e) => e.state_transitions.at(-1)?.to_state === 'offline_passed')
    const rejected = entries.filter((e) => e.state_transitions.at(-1)?.to_state === 'offline_rejected')
    expect(passed).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    expect(rejected.every((e) => e.final_disposition === 'rejected_offline')).toBe(true)
  })

  it('respects the iteration budget bound', () => {
    const ledger = makeLedger()
    const summary = runOfflineLoop({
      proposer: makeProposer(),
      scoreCandidate: makeScorer(),
      ledger,
      clock: new ManualClock('2027-01-02T16:00:00.000Z'),
      ids: new SequentialIdGenerator('seedLoopCtl'),
      maxDryIterations: 100,
      maxIterations: 2,
    })
    expect(summary.terminatedReason).toBe('budget_exhausted')
    expect(summary.iterations).toBe(2)
  })
})
