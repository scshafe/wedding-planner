import {
  loadCouplePersona,
  type ScenarioDefinition,
} from '@wedding-planner/eval-harness'
import {
  type CandidateChange,
  type Clock,
  getSchemaRegistry,
  type GuestPersona,
  type IdGenerator,
  ManualClock,
  type OversightRecord,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'
import { createMetricEngine } from '@wedding-planner/telemetry'
import {
  ChampionStore,
  GenomeRegistry,
  HmacTransitionSigner,
  landingKeyFor,
  Ledger,
  type Proposer,
  type ProposerContext,
  runGenomeOfflineLoop,
  verifyLedgerChain,
} from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

import { humanApproval } from '../fixtures/oversight_fixtures'

/**
 * Phase 4a Step 5 — THE KEYSTONE. The full genome loop proves the tier-2 gate is LOAD-BEARING.
 *
 * A tier-2 candidate (the tier-1-OPTIMAL box point (cadence 2, spacing 1) PLUS the tier-2 autonomy
 * knob) is proposed against a SUB-OPTIMAL champion, so it genuinely PASSES the offline accept rule
 * (North Star up). The RED/GREEN proof is a single fact: `accepted === 1` (a naive unconditional-promote
 * loop's promote trigger fired — it WOULD have landed the tier-2 genome) but `promoted === 0` (the gated
 * loop withheld it). With an exogenous approval it lands; with `approved:false` it is human-rejected;
 * with an under-declared tier it never even reaches the gate (the pre-score firewall rejects it).
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

// The interior-optimum guest mix (mirrors the Phase-3 keystone): resolution rises with cadence to 2 then
// saturates (the never-responder), while sentiment keeps falling — so (cadence 2, spacing 1) is the
// North-Star optimum, strictly above the seed corner (0, 0).
const GUESTS: readonly GuestPersona[] = [
  guest('guest_immediate', 'immediate'),
  guest('guest_one', 'after_one_reminder'),
  guest('guest_many', 'after_multiple_reminders', 'no'),
  guest('guest_never', 'never', 'maybe_needs_nudge'),
]

function scenario(id: string, type: ScenarioDefinition['scenario_type']): ScenarioDefinition {
  return {
    scenario_id: id,
    scenario_type: type,
    couple: COUPLE,
    guests: GUESTS,
    bookedPlanFacts: {},
    targetMetrics: [{ metric_code: 'rsvp_resolution_rate', direction: 'gte', threshold: 0.5 }],
  }
}

const CORPUS: readonly ScenarioDefinition[] = [scenario('golden_g', 'golden'), scenario('adv_a', 'adversarial')]

/** The seed champion: a SUB-OPTIMAL tier-1 box corner, so the optimum-carrying tier-2 candidate beats it. */
const SEED_CHAMPION: StrategyGenome = { genome_id: 'seed_0_0', parameters: { rsvp_reminder_cadence: 0, reminder_spacing: 0 } }

/** The tier-2 candidate genome: the tier-1 OPTIMUM (cadence 2, spacing 1) bundled with the tier-2 knob. */
function tier2Candidate(autonomy = 1): StrategyGenome {
  return { genome_id: `t2_${autonomy}`, parameters: { rsvp_reminder_cadence: 2, reminder_spacing: 1, autonomy_threshold: autonomy } }
}

/** A proposer that emits ONE pre-built candidate genome (declaring `declaredTier`) then converges. */
class SingleCandidateProposer implements Proposer {
  private emitted = false
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly registry: GenomeRegistry,
    private readonly genome: StrategyGenome,
    private readonly declaredTier: 0 | 1 | 2 | 3,
  ) {}

  propose(context: ProposerContext): CandidateChange | null {
    if (this.emitted) return null
    this.emitted = true
    const artifactRef = this.registry.register(this.genome)
    const candidate: CandidateChange = {
      candidate_id: this.ids.next('cand'),
      created_at: this.clock.now(),
      author: 'ai_proposer',
      hypothesis: {
        target_capability: 'rsvp',
        target_metric_code: 'rsvp_resolution_rate',
        target_scenario_ids: ['golden_g', 'adv_a'],
        expected_direction: 'increase',
        guards_to_watch: ['guest_sentiment_score'],
        rationale: `tier-2 candidate (iteration ${context.iteration})`,
      },
      change: {
        change_type: 'flow',
        summary: 'tier-2 escalation-autonomy candidate at the tier-1 optimum',
        artifact_ref: artifactRef,
        reversible: true,
        capabilities_touched: ['rsvp'],
        mid_engagement_safe: true,
      },
      risk_tier: this.declaredTier,
      status: 'proposed',
    }
    return getSchemaRegistry().assertValid<CandidateChange>('candidate_change', candidate)
  }
}

function runTier2Loop(opts: { genome?: StrategyGenome; declaredTier?: 0 | 1 | 2 | 3; approvals?: readonly OversightRecord[] }) {
  const genome = opts.genome ?? tier2Candidate(1)
  const championStore = new ChampionStore(SEED_CHAMPION)
  const registry = new GenomeRegistry()
  const ledger = new Ledger(new ManualClock(BASE_TS), new SequentialIdGenerator('ledger'), new HmacTransitionSigner('phase4a-key'))
  const proposer = new SingleCandidateProposer(new ManualClock(BASE_TS), new SequentialIdGenerator('prop'), registry, genome, opts.declaredTier ?? 2)
  const summary = runGenomeOfflineLoop({
    proposer,
    championStore,
    registry,
    corpus: CORPUS,
    guards: [],
    metricEngine: createMetricEngine(),
    harnessVersion: 'h4a',
    baseTimestamp: BASE_TS,
    ledger,
    clock: new ManualClock(BASE_TS),
    ids: new SequentialIdGenerator('loop'),
    maxDryIterations: 5,
    ...(opts.approvals === undefined ? {} : { approvals: opts.approvals }),
  })
  return { championStore, registry, ledger, summary }
}

function lastStates(ledger: Ledger): string[] {
  return ledger.allEntries()[0]?.state_transitions.map((t) => t.to_state) ?? []
}

describe('keystone — the tier-2 promotion gate is load-bearing', () => {
  it('(a/g) NO approval: an accepted tier-2 candidate PARKS — the champion never ratchets to it (the rail)', () => {
    const { championStore, summary, ledger } = runTier2Loop({ approvals: [] })

    // RED on a naive loop / GREEN on the gated loop, in one fact: the candidate PASSED the accept rule
    // (a naive unconditional-promote loop would have landed it) but the gate WITHHELD it.
    expect(summary.accepted).toBe(1)
    expect(summary.promoted).toBe(0)
    expect(summary.parked).toBe(1)

    // The autonomous loop did NOT self-grant tier-2 autonomy: the champion is still the seed.
    expect(championStore.current()).toBe(SEED_CHAMPION)
    expect(championStore.current().parameters.autonomy_threshold).toBeUndefined()

    // The park is tamper-evidently ledgered: offline_passed -> human_review -> parked.
    expect(lastStates(ledger)).toEqual(['implemented', 'offline_scoring', 'offline_passed', 'human_review', 'parked'])
    expect(ledger.allEntries()[0]?.final_disposition).toBe('parked')
    expect(verifyLedgerChain(ledger.allEntries()[0]!)).toEqual({ valid: true })
  })

  it('(b) WITH a matching approval: the tier-2 candidate LANDS (champion ratchets, decided_by human)', () => {
    const genome = tier2Candidate(1)
    const approval = humanApproval(landingKeyFor(genome, SEED_CHAMPION), true)
    const { championStore, summary, ledger } = runTier2Loop({ genome, approvals: [approval] })

    expect(summary.promoted).toBe(1)
    expect(summary.parked).toBe(0)
    expect(championStore.current().parameters.autonomy_threshold).toBe(1)
    expect(championStore.current().parameters.rsvp_reminder_cadence).toBe(2)
    expect(lastStates(ledger)).toEqual(['implemented', 'offline_scoring', 'offline_passed', 'human_review', 'promoted'])
    expect(ledger.allEntries()[0]?.state_transitions.at(-1)?.decided_by).toBe('human')
  })

  it('(c) WITH approved:false: the tier-2 candidate is HUMAN-REJECTED, not parked-for-retry', () => {
    const genome = tier2Candidate(1)
    const rejection = humanApproval(landingKeyFor(genome, SEED_CHAMPION), false)
    const { championStore, summary, ledger } = runTier2Loop({ genome, approvals: [rejection] })

    expect(summary.humanRejected).toBe(1)
    expect(summary.promoted).toBe(0)
    expect(summary.parked).toBe(0)
    expect(championStore.current()).toBe(SEED_CHAMPION)
    expect(lastStates(ledger).at(-1)).toBe('human_rejected')
    expect(ledger.allEntries()[0]?.final_disposition).toBe('rejected_human')
  })

  it('(f) an UNDER-DECLARED tier-2 candidate (declares tier 1) never reaches the gate — the pre-score firewall rejects it', () => {
    // The pre-score risk-tier reconciliation independently derives tier 2 and rejects the under-declared
    // candidate BEFORE scoring. So it is rejected (firewall), not parked (gate) — two independent
    // derivations, both fail-closed.
    const { championStore, summary, ledger } = runTier2Loop({ declaredTier: 1, approvals: [] })

    expect(summary.accepted).toBe(0)
    expect(summary.parked).toBe(0)
    expect(summary.rejected).toBe(1)
    expect(championStore.current()).toBe(SEED_CHAMPION)
    const states = lastStates(ledger)
    expect(states.at(-1)).toBe('offline_rejected')
    expect(ledger.allEntries()[0]?.state_transitions.at(-1)?.decided_by).toBe('risk_tier_gate')
  })
})
