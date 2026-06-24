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
 * @canonical search_proposer -- the offline, credential-free analogue of the creative Claude proposer.
 *
 * It perturbs the CHAMPION genome (read from the injected ChampionStore each call) toward the target
 * capability, registers the new genome (content-addressed), and emits a schema-valid candidate_change
 * whose artifact_ref commits to exactly that genome and whose risk_tier is the HONESTLY DERIVED tier
 * (deriveRiskTier) — not a self-chosen number. The future Claude proposer plugs into the SAME Proposer
 * interface and authors the SAME genome type; only the idea-generation differs (proposer_design.md).
 *
 * Search shape — stated honestly (wolf, Phase-2 Step-6 review):
 *  - It is a DETERMINISTIC distance-ordered enumeration of the champion's in-range neighbors (no
 *    Math.random), so a run replays identically and a metric delta is attributable to the genome.
 *  - `move: exploit` (distance 1) vs `explore` (distance >1) is an honest LABEL on each neighbor's
 *    distance, NOT a regime-choosing policy: the enumeration walks near-before-far regardless of how
 *    scoring goes. A real explore/exploit policy (widen when exploits stall) is deferred to the next
 *    phase, with the rest of the generalization below.
 *
 * NEVER re-proposes a genome it has already emitted: dedupe is on the GENOME CONTENT HASH, not the
 * candidate_id (rigorous-architect — else a rejected genome reappears under a fresh id forever). When
 * every in-range neighbor of the current champion has been tried, propose() returns null and the loop
 * terminates `proposer_exhausted` / goes dry.
 *
 * KNOWN LIMITATION (wolf — defer the fix to the next phase, do not retrofit onto the toy space):
 * `proposedHashes` is a GLOBAL tabu over genome identity, never cleared. After the champion ratchets,
 * a neighbor of the NEW champion that was tried-and-rejected against a PRIOR champion is not retried,
 * even though the baseline it would now be scored against differs. For the monotonic single-knob
 * ratchet this only causes earlier exhaustion (a genome that lost to a weaker champion is unlikely to
 * beat a stronger one); for a multi-knob landscape it would systematically miss interaction wins. The
 * principled next-phase fix is a TRAJECTORY-RELATIVE tabu + a termination taxonomy that distinguishes
 * "local optimum" from "globally converged" (today both surface as `dry`), plus a low-discrepancy
 * deterministic sequence over the parameter box instead of axis-aligned distance-1 steps.
 *
 * related: genome/champion_store.ts, genome/genome_registry.ts, pipeline/risk_tier_reconciliation.ts.
 */

export interface SearchProposerSpec {
  readonly target_capability: CandidateChange['hypothesis']['target_capability']
  readonly target_metric_code: string
  readonly expected_direction: CandidateChange['hypothesis']['expected_direction']
  readonly guards_to_watch: readonly string[]
  readonly target_scenario_ids?: readonly string[]
  readonly change_type: CandidateChange['change']['change_type']
  /** Inclusive bounds of the rsvp_reminder_cadence search range (defaults to the schema's 0..3). */
  readonly cadenceMin?: number
  readonly cadenceMax?: number
}

/** A perturbation off the champion: the new genome and whether it was an exploit or explore move. */
interface Perturbation {
  readonly genome: StrategyGenome
  readonly move: 'exploit' | 'explore'
  readonly cadence: number
}

export class SearchProposer implements Proposer {
  /** Content hashes of every genome this proposer has emitted — the dedupe key. */
  private readonly proposedHashes = new Set<string>()
  private readonly cadenceMin: number
  private readonly cadenceMax: number

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly championStore: ChampionStore,
    private readonly registry: GenomeRegistry,
    private readonly spec: SearchProposerSpec,
  ) {
    this.cadenceMin = spec.cadenceMin ?? 0
    this.cadenceMax = spec.cadenceMax ?? 3
  }

  propose(context: ProposerContext): CandidateChange | null {
    const champion = this.championStore.current()
    const perturbation = this.nextUntriedPerturbation(champion)
    if (perturbation === null) {
      return null // neighborhood exhausted -> loop terminates proposer_exhausted / dry
    }

    this.proposedHashes.add(canonicalGenomeHash(perturbation.genome))
    const artifactRef = this.registry.register(perturbation.genome)
    const riskTier = deriveRiskTier(perturbation.genome).tier

    const candidate: CandidateChange = {
      candidate_id: this.ids.next('cand'),
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
          `${perturbation.move} move: rsvp_reminder_cadence ` +
          `${champion.parameters.rsvp_reminder_cadence} -> ${perturbation.cadence} ` +
          `(iteration ${context.iteration}; ${context.lessons.length} prior lesson(s)).`,
      },
      change: {
        change_type: this.spec.change_type,
        summary: `${perturbation.move} cadence to ${perturbation.cadence} for ${this.spec.target_capability}.`,
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

  /** The first distance-ordered in-range neighbor of the champion whose genome is untried, or null. */
  private nextUntriedPerturbation(champion: StrategyGenome): Perturbation | null {
    const base = champion.parameters.rsvp_reminder_cadence
    for (const cadence of this.distanceOrderedNeighbors(base)) {
      const genome = this.genomeFor(cadence)
      if (!this.proposedHashes.has(canonicalGenomeHash(genome))) {
        return { genome, cadence, move: Math.abs(cadence - base) === 1 ? 'exploit' : 'explore' }
      }
    }
    return null
  }

  /** In-range cadences ordered by distance from `base` (exploit-near before explore-far), deduped. */
  private distanceOrderedNeighbors(base: number): number[] {
    const span = this.cadenceMax - this.cadenceMin
    const ordered: number[] = []
    for (let distance = 1; distance <= span; distance += 1) {
      for (const candidate of [base + distance, base - distance]) {
        if (candidate >= this.cadenceMin && candidate <= this.cadenceMax) {
          ordered.push(candidate)
        }
      }
    }
    return [...new Set(ordered)]
  }

  /** A genome at a cadence, with a deterministic id (id is inert to the content hash). */
  private genomeFor(cadence: number): StrategyGenome {
    return { genome_id: `g_search_cadence_${cadence}`, parameters: { rsvp_reminder_cadence: cadence } }
  }
}
