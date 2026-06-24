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
  return { genome_id, parameters: { rsvp_reminder_cadence: cadence } }
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
  function makeLoop(seedCadence: number) {
    const championStore = new ChampionStore(genome(seedCadence))
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
    return { championStore, registry, ledger, proposer }
  }

  it('hill-climbs 0->1->2 (two promotions), tries and REJECTS the overshoot, then exhausts', () => {
    const { championStore, registry, ledger, proposer } = makeLoop(0)
    const summary = runGenomeOfflineLoop({
      proposer,
      championStore,
      registry,
      corpus: CORPUS,
      guards: [], // the cadence tradeoff lives in the North Star, not a hard guard
      metricEngine: createMetricEngine(),
      harnessVersion: 'h2',
      baseTimestamp: BASE_TS,
      ledger,
      clock: new ManualClock(BASE_TS),
      ids: new SequentialIdGenerator('loopCtl'),
      maxDryIterations: 3,
    })

    // The champion ratcheted to the North-Star-optimal cadence (2) via EXACTLY two promotions (0->1->2).
    expect(championStore.current().parameters.rsvp_reminder_cadence).toBe(2)
    expect(summary.accepted).toBe(2)
    // It terminates because the neighborhood is exhausted (not because maxDryIterations was hit).
    expect(summary.terminatedReason).toBe('proposer_exhausted')

    // The optimality claim: the cadence-3 OVERSHOOT was actually proposed (registered) AND refused —
    // the champion is 2, not 3, despite 3 being tried. "Ended at 2 because 3 was tried and rejected."
    expect(registry.has(genomeArtifactRef(genome(3)))).toBe(true)
    expect(summary.rejected).toBeGreaterThanOrEqual(1)

    // Every ledger chain is intact.
    for (const entry of ledger.allEntries()) {
      expect(verifyLedgerChain(entry)).toEqual({ valid: true })
    }
    // The promoted candidates' lineage (genome hash) is anchored in the append-only ledger.
    const promotedLineage = ledger
      .allEntries()
      .flatMap((entry) => entry.lessons ?? [])
      .filter((lesson) => lesson.startsWith('champion_lineage:'))
    expect(promotedLineage.length).toBe(2)
  })

  it('re-centers after promotion: the proposer explores the NEW champion neighborhood (wolf)', () => {
    // wolf's highest-value missing test. Seed champion 0; the proposer's first candidate is a
    // neighbor of 0. Promote to 2; the next candidate must be a neighbor of 2 (1 or 3), not of 0.
    const { championStore, registry, proposer } = makeLoop(0)
    const ctx = (i: number) => ({ iteration: i, weakestCapability: 'rsvp', lessons: [] as string[] })

    const first = proposer.propose(ctx(0)) as CandidateChange
    const firstCadence = registry.resolve(first.change.artifact_ref)?.parameters.rsvp_reminder_cadence as number
    // A neighbor of champion 0 (distance <= 1). Assert the DISTANCE, not the literal, so this doesn't
    // pin the proposer's tie-break order (testineer Step-7).
    expect(Math.abs(firstCadence - 0)).toBeLessThanOrEqual(1)

    championStore.promote(genome(2)) // champion moves
    const next = proposer.propose(ctx(1)) as CandidateChange
    const nextCadence = registry.resolve(next.change.artifact_ref)?.parameters.rsvp_reminder_cadence as number
    // The next proposal is a neighbor of the NEW champion (2), not the old (0): distance <= 1 from 2.
    expect(Math.abs(nextCadence - 2)).toBeLessThanOrEqual(1)
    expect(nextCadence).not.toBe(firstCadence) // not re-centered on the old champion
  })
})
