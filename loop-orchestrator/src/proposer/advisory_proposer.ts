import {
  type CandidateChange,
  canonicalGenomeHash,
  type Clock,
  deriveRiskTier,
  getSchemaRegistry,
  type IdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'

import { type ChampionStore } from '../genome/champion_store'
import { type GenomeRegistry } from '../genome/genome_registry'
import { type Proposer, type ProposerContext } from './proposer'

/**
 * @canonical advisory_proposer -- the TIER-2 exploration proposer (Phase 11). It is the deliberate
 * counterpart to SearchProposer: where SearchProposer enumerates the tier-1 reminder box and NEVER
 * emits `autonomy_threshold` (so the autonomous search auto-lands only tier-1), this proposer
 * enumerates ONLY tier-2 candidates — the same tier-1 base genome with `autonomy_threshold` set to
 * each value in a small range. Every genome it emits therefore HONESTLY derives tier 2 (presence of
 * `autonomy_threshold` elevates the genome; see shared/strategy/risk_tier.ts).
 *
 * It exists so the DORMANT plan-side value (consulting the couple to align a vision-sensitive booked
 * category — quality, the 0.40 North-Star component) can be EXPLORED and surfaced as a recommendation.
 * It is wired ONLY into the advisory pass (loop/advisory_loop.ts), never the auto-landing loop: the
 * promotion gate routes its tier-2 candidates to human_review and — with no exogenous approval — PARKS
 * them. The parked set is the recommendation set. The loop never lands a tier-2 candidate autonomously
 * (MAX_AUTONOMOUS_PROMOTION_TIER = 1).
 *
 * Why a SEPARATE class, not a branch in SearchProposer (doddy P1-B): the "box is tier-1" guarantee is a
 * structural property of SearchProposer (it never emits autonomy_threshold). Adding a tier-2 branch
 * there would make that guard test protect nothing. Keeping the two proposers distinct means the
 * advisory proposer can NEVER be the auto-loop's proposer by construction — the guard test pins both
 * (SearchProposer emits only tier-1; this proposer emits only tier-2).
 *
 * It mirrors SearchProposer's contract: content-addressed genome registration, honestly-derived
 * `risk_tier` (never self-chosen), trajectory-relative tabu keyed by the standing champion, and a
 * convergence certificate (`isConverged()` true once every autonomy level has been proposed against the
 * current champion). In the advisory pass the champion is FROZEN (every accept parks, never ratchets),
 * so the tabu simply tracks coverage against that single frozen base.
 *
 * related: proposer/search_proposer.ts (the tier-1 sibling), loop/advisory_loop.ts (the only wiring),
 * pipeline/promotion_gate.ts (parks the tier-2 candidates), memory: second-genome-knob-must-stay-tier1.
 */

export interface AdvisoryProposerSpec {
  readonly target_capability: CandidateChange['hypothesis']['target_capability']
  readonly target_metric_code: string
  readonly expected_direction: CandidateChange['hypothesis']['expected_direction']
  readonly guards_to_watch: readonly string[]
  readonly target_scenario_ids?: readonly string[]
  readonly change_type: CandidateChange['change']['change_type']
  /** Inclusive bounds of the autonomy_threshold exploration range (defaults to the schema's 1..3). */
  readonly autonomyMin?: number
  readonly autonomyMax?: number
}

export class AdvisoryProposer implements Proposer {
  /** Trajectory-relative tabu: championHash -> the genome hashes already proposed against it. */
  private readonly proposedAgainst = new Map<string, Set<string>>()
  /** The fixed enumeration of autonomy_threshold levels this proposer explores. */
  private readonly autonomyLevels: readonly number[]

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly championStore: ChampionStore,
    private readonly registry: GenomeRegistry,
    private readonly spec: AdvisoryProposerSpec,
  ) {
    const min = this.spec.autonomyMin ?? 1
    const max = this.spec.autonomyMax ?? 3
    const levels: number[] = []
    for (let level = min; level <= max; level += 1) {
      levels.push(level)
    }
    this.autonomyLevels = levels
  }

  /** The number of tier-2 candidates this proposer can emit against a single champion. */
  get boxSize(): number {
    return this.autonomyLevels.length
  }

  /** How many distinct genomes have been proposed against `championHash` so far. */
  evaluatedCountFor(championHash: string): number {
    return this.proposedAgainst.get(championHash)?.size ?? 0
  }

  /**
   * True iff every autonomy level has been proposed against the CURRENT standing champion — the
   * convergence certificate the advisory wrapper reads as "the tier-2 frontier is fully explored".
   * Unlike SearchProposer, the champion itself is a tier-1 genome (not one of the emitted points), so
   * full coverage is the whole `boxSize`, not `boxSize - 1`.
   */
  isConverged(): boolean {
    return this.evaluatedCountFor(this.championStore.currentHash()) >= this.boxSize
  }

  propose(context: ProposerContext): CandidateChange | null {
    const champion = this.championStore.current()
    const championHash = canonicalGenomeHash(champion)
    const tried = this.proposedAgainst.get(championHash) ?? new Set<string>()

    for (const autonomy of this.autonomyLevels) {
      const genome = this.genomeFor(champion, autonomy)
      const genomeHash = canonicalGenomeHash(genome)
      if (genomeHash === championHash) continue // a tier-1 champion never equals a tier-2 genome, but be safe
      if (tried.has(genomeHash)) continue // already proposed against THIS champion (trajectory tabu)

      tried.add(genomeHash)
      this.proposedAgainst.set(championHash, tried)
      return this.candidateFor(genome, champion, autonomy, context)
    }
    return null // every autonomy level proposed against the standing champion -> the frontier is explored
  }

  /** Build the schema-valid, content-addressed, HONESTLY tier-2 candidate for an autonomy level. */
  private candidateFor(
    genome: StrategyGenome,
    champion: StrategyGenome,
    autonomy: number,
    context: ProposerContext,
  ): CandidateChange {
    const artifactRef = this.registry.register(genome)
    // The honestly DERIVED tier (tier 2, because autonomy_threshold is present), never a self-chosen
    // number — so it reconciles cleanly at the pre-score gate and reaches the park, not a firewall reject.
    const riskTier = deriveRiskTier(genome).tier

    const candidate: CandidateChange = {
      candidate_id: this.ids.next('adv'),
      created_at: this.clock.now(),
      author: 'ai_proposer',
      hypothesis: {
        target_capability: this.spec.target_capability,
        target_metric_code: this.spec.target_metric_code,
        ...(this.spec.target_scenario_ids === undefined
          ? {}
          : { target_scenario_ids: [...this.spec.target_scenario_ids] }),
        expected_direction: this.spec.expected_direction,
        guards_to_watch: [...this.spec.guards_to_watch],
        rationale:
          `advisory tier-2 exploration: enable couple consultation (autonomy_threshold ${autonomy}) ` +
          `over the tier-1 base (cadence ${champion.parameters.rsvp_reminder_cadence}, spacing ` +
          `${champion.parameters.reminder_spacing}, batching ${champion.parameters.reminder_batching}) ` +
          `(iteration ${context.iteration}; ${context.lessons.length} prior lesson(s)). PARKS pending human approval.`,
      },
      change: {
        change_type: this.spec.change_type,
        summary: `tier-2: autonomy_threshold ${autonomy} for ${this.spec.target_capability} (advisory; never auto-lands).`,
        artifact_ref: artifactRef,
        reversible: true,
        capabilities_touched: [this.spec.target_capability],
        mid_engagement_safe: true,
      },
      risk_tier: riskTier,
      status: 'proposed',
    }
    return getSchemaRegistry().assertValid<CandidateChange>('candidate_change', candidate)
  }

  /** A tier-2 genome: the tier-1 champion's flow knobs plus an `autonomy_threshold` (which elevates it). */
  private genomeFor(champion: StrategyGenome, autonomy: number): StrategyGenome {
    return {
      genome_id: `g_advisory_a${autonomy}`,
      // The base tier-1 flow knobs are carried verbatim; autonomy_threshold is the ONLY added knob, so
      // the genome derives tier 2 and the candidate parks (never auto-lands). This is the deliberate
      // inverse of SearchProposer.genomeFor, which never emits autonomy_threshold.
      parameters: {
        rsvp_reminder_cadence: champion.parameters.rsvp_reminder_cadence,
        reminder_spacing: champion.parameters.reminder_spacing,
        reminder_batching: champion.parameters.reminder_batching,
        autonomy_threshold: autonomy,
      },
    }
  }
}
