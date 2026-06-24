import {
  guardSpecsFor,
  makePlannerSimulator,
  scoreCandidateOffline,
  type ScenarioDefinition,
  loadCouplePersona,
} from '@wedding-planner/eval-harness'
import {
  type CandidateChange,
  genomeArtifactRef,
  type GuestPersona,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { createMetricEngine } from '@wedding-planner/telemetry'
import {
  ChampionStore,
  computeSurpriseCheck,
  GenomeRegistry,
  HmacTransitionSigner,
  Ledger,
  runGenomeOfflineLoop,
  runOfflineSelection,
  SearchProposer,
  verifyLedgerChain,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

/**
 * Step 7 — THE KEYSTONE. The candidate-blind stub is gone: a candidate's GENOME (content-addressed,
 * run through the two-stage simulator, scored by the UNMODIFIED harness) drives whether it wins. The
 * positive arm asserts the full causal chain (genome delta -> metric moved -> hypothesis_confirmed ->
 * North Star up -> accepted -> champion promoted); the negative arm asserts a regressing genome is
 * rejected with a lesson. A guard-mechanism test shows the guard is live against the new substrate,
 * and a full loop run climbs to the interior optimum (cadence 2 on this corpus).
 */

const BASE_TS = '2027-05-01T12:00:00.000Z'
const COUPLE = loadCouplePersona('couple_standard_baseline')

function guest(personaId: string, latency: GuestPersona['rsvp_truth']['response_latency'], will: GuestPersona['rsvp_truth']['will_attend'] = 'yes'): GuestPersona {
  return {
    persona_id: personaId,
    description: `g ${personaId}`,
    relationship: { to_couple: 'friend', side: 'both' },
    contact: { preferred_channel: 'email', preferred_language: 'en' },
    rsvp_truth: { will_attend: will, response_latency: latency },
    questions: [],
    personalization_expectations: { expected_tone: 'friendly_peer', expected_language: 'en' },
  }
}

// A guest mix with an interior optimum: resolution rises with cadence up to 2, then saturates (the
// never-responder), while sentiment keeps falling — so cadence 2 maximizes the North Star.
const GUESTS: readonly GuestPersona[] = [
  guest('guest_immediate', 'immediate'),
  guest('guest_one', 'after_one_reminder'),
  guest('guest_many', 'after_multiple_reminders', 'no'),
  guest('guest_never', 'never', 'maybe_needs_nudge'),
]

function scenario(
  id: string,
  type: ScenarioDefinition['scenario_type'],
  guests: readonly GuestPersona[] = GUESTS,
): ScenarioDefinition {
  return {
    scenario_id: id,
    scenario_type: type,
    couple: COUPLE,
    guests,
    bookedPlanFacts: {},
    targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.5 }],
  }
}

// A cadence-INSENSITIVE scenario (all-immediate responders, no never-guest): its rsvp_resolution_rate
// and sentiment are 1.0 at every cadence, so it contributes ZERO gain. It is NOT in the hypothesis's
// target_scenario_ids, so it makes target_attribution_share a real localization test: a correct
// simulator leaves it flat (attribution ~1.0), but a MIS-localized simulator that moved it would drop
// the share below 1.0 (testineer Step-7 review — otherwise the off-target denominator is empty and the
// attribution assertion is vacuous).
const FLAT_GUESTS: readonly GuestPersona[] = [
  guest('guest_flat_a', 'immediate'),
  guest('guest_flat_b', 'immediate', 'no'),
]

const CORPUS: readonly ScenarioDefinition[] = [
  scenario('golden_g', 'golden'),
  scenario('adv_a', 'adversarial'),
  scenario('s_flat', 'golden', FLAT_GUESTS), // non-target, cadence-insensitive control
]

function genome(cadence: number, genome_id = `g_${cadence}`): StrategyGenome {
  return { genome_id, parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: 0 } }
}

/** A genome at an explicit (cadence, spacing) box point. */
function genome2(cadence: number, spacing: number): StrategyGenome {
  return { genome_id: `g_${cadence}_${spacing}`, parameters: { rsvp_reminder_cadence: cadence, reminder_spacing: spacing } }
}

function scoreChallenger(championCadence: number, candidateCadence: number, guardCodes: string[] = []) {
  const candidateGenome = genome(candidateCadence)
  const runner = makePlannerSimulator({
    championGenome: genome(championCadence),
    candidateGenome,
    candidateArtifactRef: genomeArtifactRef(candidateGenome),
    baseTimestamp: BASE_TS,
  })
  return scoreCandidateOffline({
    corpus: CORPUS,
    runner,
    guards: guardSpecsFor(guardCodes),
    metricEngine: createMetricEngine(),
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator(`score_${championCadence}_${candidateCadence}`),
    harnessVersion: 'h2',
  })
}

/** A candidate change carrying the genome at `cadence` (hypothesis targets rsvp_resolution_rate). */
function candidateFor(cadence: number): CandidateChange {
  return {
    candidate_id: `cand_${cadence}`,
    created_at: BASE_TS,
    author: 'ai_proposer',
    hypothesis: {
      target_capability: 'rsvp',
      target_metric_code: 'rsvp_resolution_rate',
      target_scenario_ids: ['golden_g', 'adv_a'],
      expected_direction: 'increase',
      guards_to_watch: ['guest_sentiment_score'],
      rationale: `cadence to ${cadence}`,
    },
    change: {
      change_type: 'flow',
      summary: `cadence ${cadence}`,
      artifact_ref: genomeArtifactRef(genome(cadence)),
      reversible: true,
      capabilities_touched: ['rsvp'],
    },
    risk_tier: 1,
    status: 'proposed',
  }
}

describe('keystone — positive arm: a better genome wins the whole chain', () => {
  it('genome delta -> metric moved -> hypothesis_confirmed -> North Star up -> accepted', () => {
    const result = scoreChallenger(0, 2) // champion cadence 0, challenger cadence 2

    // The metric actually moved, computed by the real engine over simulator-produced events.
    const candRate = result.candidate[0]?.metric_values['rsvp_resolution_rate'] as number
    const baseRate = result.baseline[0]?.metric_values['rsvp_resolution_rate'] as number
    expect(candRate).toBeGreaterThan(baseRate)

    // The North Star rose and the accept rule accepted.
    expect(result.decision.aggregate_north_star_delta).toBeGreaterThan(0)
    expect(result.decision.accepted).toBe(true)

    // The surprise check confirms the WIN CAME FROM THE TARGETED METRIC on the targeted scenarios.
    const surprise = computeSurpriseCheck(candidateFor(2).hypothesis, result)
    expect(surprise.hypothesis_confirmed).toBe(true)
    expect(surprise.observed_target_delta as number).toBeGreaterThan(0)
    expect(surprise.target_attribution_share).toBeGreaterThan(0.99)
  })
})

describe('keystone — negative arm: a regressing genome is rejected with a lesson', () => {
  it('past the interior optimum (cadence 2 -> 3): resolution saturates, North Star falls -> rejected', () => {
    const ledger = new Ledger(
      new ManualClock(BASE_TS),
      new SequentialIdGenerator('ledgerNeg'),
      new HmacTransitionSigner('phase2-key'),
    )
    const candidate = candidateFor(3)
    ledger.append({
      candidate_id: candidate.candidate_id,
      from_state: 'proposed',
      to_state: 'implemented',
      decided_by: 'ai_proposer',
      rationale: 'r',
    })
    const result = scoreChallenger(2, 3) // champion at the optimum, challenger overshoots
    expect(result.decision.accepted).toBe(false)
    // STRICTLY negative — a true regression, not mere saturation/non-improvement (testineer Step-7).
    expect(result.decision.aggregate_north_star_delta).toBeLessThan(0)

    const selection = runOfflineSelection(candidate, result, ledger)
    expect(selection.accepted).toBe(false)
    const entry = ledger.getEntry(candidate.candidate_id)
    expect(entry?.lessons?.some((lesson) => lesson.startsWith('offline_rejected'))).toBe(true)
  })

  it('the guard mechanism is live against the substrate: a sentiment guard rejects a nagging genome', () => {
    // With guest_sentiment_score declared a hard guard, cadence 0 -> 2 raises resolution but the
    // guard regresses, so condition 3 rejects even though the North Star rose. (The loop's default
    // policy keeps sentiment in the North Star, not as a hard guard — but the mechanism works.)
    const result = scoreChallenger(0, 2, ['guest_sentiment_score'])
    expect(result.decision.aggregate_north_star_delta).toBeGreaterThan(0)
    expect(result.decision.guard_regressions.length).toBeGreaterThan(0)
    expect(result.decision.accepted).toBe(false)
  })
})

describe('keystone — the full loop climbs to the interior optimum and ratchets the champion', () => {
  function runFullLoopWith(
    seedCadence: number,
    seedSpacing: number,
    overrides: { maxDryIterations?: number; maxIterations?: number } = {},
  ) {
    const championStore = new ChampionStore(genome2(seedCadence, seedSpacing))
    const registry = new GenomeRegistry()
    const ledger = new Ledger(
      new ManualClock(BASE_TS),
      new SequentialIdGenerator('ledgerLoop'),
      new HmacTransitionSigner('phase2-key'),
    )
    const proposer = new SearchProposer(
      new ManualClock(BASE_TS),
      new SequentialIdGenerator('proposerLoop'),
      championStore,
      registry,
      {
        target_capability: 'rsvp',
        target_metric_code: 'rsvp_resolution_rate',
        expected_direction: 'increase',
        guards_to_watch: ['guest_sentiment_score'],
        target_scenario_ids: ['golden_g', 'adv_a'],
        change_type: 'flow',
      },
    )
    const summary = runGenomeOfflineLoop({
      proposer,
      championStore,
      registry,
      corpus: CORPUS,
      guards: [], // the cadence/spacing tradeoff lives in the North Star, not a hard guard
      metricEngine: createMetricEngine(),
      harnessVersion: 'h2',
      baseTimestamp: BASE_TS,
      ledger,
      clock: new ManualClock(BASE_TS),
      ids: new SequentialIdGenerator('loopCtl'),
      // >= boxSize so the final full sweep (all others rejected) does not trip maxDry before the
      // proposer reports coverage-complete.
      maxDryIterations: overrides.maxDryIterations ?? 20,
      ...(overrides.maxIterations === undefined ? {} : { maxIterations: overrides.maxIterations }),
    })
    return { championStore, registry, ledger, summary, proposer }
  }

  /** Run to convergence with the default (loose) caps. */
  function runFullLoop(seedCadence: number, seedSpacing = 0) {
    return runFullLoopWith(seedCadence, seedSpacing)
  }

  it('climbs the 2-D box to the INTERIOR optimum (cadence 2, spacing 1) and ratchets the champion', () => {
    const { championStore, ledger, summary, proposer } = runFullLoop(0, 0)

    // The champion ratcheted to the North-Star-optimal box point (cadence 2, spacing 1) — a point that
    // the old 1-D (spacing-pinned) search could never have reached.
    expect(championStore.current().parameters.rsvp_reminder_cadence).toBe(2)
    expect(championStore.current().parameters.reminder_spacing).toBe(1)
    expect(summary.accepted).toBeGreaterThanOrEqual(1)
    // It terminates with the CONVERGENCE CERTIFICATE: the box was exhausted against the standing
    // champion with nothing acceptable (not a maxDry stall, not a budget cap).
    expect(summary.terminatedReason).toBe('converged')
    // The promotion count is bounded by the box (each accept strictly raises the champion North Star).
    expect(summary.accepted).toBeLessThanOrEqual(proposer.boxSize)

    // Every ledger chain is intact.
    for (const entry of ledger.allEntries()) {
      expect(verifyLedgerChain(entry)).toEqual({ valid: true })
    }
    // One champion_lineage lesson per promotion.
    const promotedLineage = ledger
      .allEntries()
      .flatMap((entry) => entry.lessons ?? [])
      .filter((lesson) => lesson.startsWith('champion_lineage:'))
    expect(promotedLineage.length).toBe(summary.accepted)
  })

  it('converges to the SAME optimum from a different seed (champion-independent convergence)', () => {
    const { championStore } = runFullLoop(3, 3) // start at the opposite corner
    expect(championStore.current().parameters.rsvp_reminder_cadence).toBe(2)
    expect(championStore.current().parameters.reminder_spacing).toBe(1)
  })

  it('TAXONOMY: a tight maxDry STALLS (dry, no certificate); a loose maxDry CONVERGES (certificate)', () => {
    // The distinction Phase 2 could not make. Same landscape + seed; only maxDryIterations differs.
    // A tight budget trips on a run of non-accepts BEFORE the box is swept -> `dry` (stalled, NOT a
    // certificate). A budget >= the box lets the proposer exhaust -> `converged` (the certificate).
    const tight = runFullLoopWith(0, 0, { maxDryIterations: 2 })
    expect(tight.summary.terminatedReason).toBe('dry')

    const loose = runFullLoopWith(0, 0, { maxDryIterations: 20 })
    expect(loose.summary.terminatedReason).toBe('converged')
  })

  it('BUDGET: a maxIterations cap below the search size stops with no certificate (budget_exhausted)', () => {
    const capped = runFullLoopWith(0, 0, { maxDryIterations: 20, maxIterations: 3 })
    expect(capped.summary.terminatedReason).toBe('budget_exhausted')
  })
})
