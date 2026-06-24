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
 * @canonical search_proposer -- the offline, credential-free analogue of the creative Claude proposer,
 * generalized in Phase 3 to a MULTI-PARAMETER (2-D) genome box search.
 *
 * Each call it reads the CURRENT champion (from the injected ChampionStore), picks the next untried
 * box point in a fixed spread-first order, registers the genome (content-addressed), and emits a
 * schema-valid candidate_change whose artifact_ref commits to exactly that genome and whose risk_tier
 * is the HONESTLY DERIVED tier (deriveRiskTier), not a self-chosen number. The future Claude proposer
 * plugs into the SAME Proposer interface and authors the SAME genome type.
 *
 * THREE Phase-3 design properties (each replacing a Phase-2 toy limitation wolf flagged):
 *
 *  1. FULL-BOX, CHAMPION-INDEPENDENT, SPREAD-FIRST ENUMERATION. The proposer enumerates the WHOLE
 *     parameter box (cadence × spacing) in a FIXED order derived from the bit-reversal (van der Corput
 *     base 2) of each point's row-major index — a deterministic space-filling permutation that does
 *     NOT re-center on the champion. Phase 2 walked the champion's axis-aligned distance-1 neighbours,
 *     which traps the search near the champion. HONEST framing of the value (the order is
 *     OUTCOME-NEUTRAL under a box-sufficient budget — a full sweep evaluates every point regardless of
 *     order): it only changes coverage when `maxIterations` truncates a sweep, where spread-first
 *     reaches far-from-champion points a champion-local order would not get to within the budget.
 *
 *  2. TRAJECTORY-RELATIVE TABU. Dedupe is keyed `(championHashAtProposal, genomeHash)`, NOT a single
 *     global genome set. A point that was tried-and-not-accepted against a PRIOR champion is eligible
 *     again once the champion ratchets, because it is now scored against a different baseline (Phase 2
 *     used a global tabu that never re-opened — the multi-knob interaction-miss). Content-addressing +
 *     the strictly-increasing champion North Star on accept mean this cannot cycle.
 *
 *  3. A CONVERGENCE CERTIFICATE. propose() returns null exactly when every other box point has been
 *     proposed against the CURRENT standing champion (per-champion coverage is complete). The loop
 *     reads that as `converged` — "no box point is acceptable against the standing champion" (NOT a
 *     global North-Star optimum: with guards/golden conditions a higher-North-Star point can be
 *     vetoed). Mid-sweep promotions cannot falsely certify because coverage is tracked PER champion
 *     hash, so points evaluated against champion A never count toward champion B's certificate.
 *
 * related: genome/champion_store.ts, genome/genome_registry.ts, pipeline/risk_tier_reconciliation.ts,
 * loop/genome_offline_loop.ts (reads the certificate), memory: second-genome-knob-must-stay-tier1.
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
  /** Inclusive bounds of the reminder_spacing search range (defaults to the schema's 0..3). */
  readonly spacingMin?: number
  readonly spacingMax?: number
}

/** A point in the integer parameter box. */
interface BoxPoint {
  readonly cadence: number
  readonly spacing: number
}

/** Reverse the low `bits` bits of `value` (the van der Corput / bit-reversal scramble). */
function bitReverse(value: number, bits: number): number {
  let reversed = 0
  let v = value
  for (let i = 0; i < bits; i += 1) {
    reversed = (reversed << 1) | (v & 1)
    v >>= 1
  }
  return reversed
}

export class SearchProposer implements Proposer {
  /**
   * Trajectory-relative tabu: championHash -> the set of genome hashes already proposed WHILE that
   * champion was standing. Keyed per champion so a point re-opens after the champion ratchets, and so
   * the convergence certificate counts only proposals against the CURRENT champion.
   */
  private readonly proposedAgainst = new Map<string, Set<string>>()
  /** The fixed, champion-independent spread-first enumeration of the whole box. */
  private readonly boxOrder: readonly BoxPoint[]

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly championStore: ChampionStore,
    private readonly registry: GenomeRegistry,
    private readonly spec: SearchProposerSpec,
  ) {
    this.boxOrder = this.buildBoxOrder()
  }

  /** The number of distinct points in the parameter box. */
  get boxSize(): number {
    return this.boxOrder.length
  }

  /** How many distinct genomes have been proposed against `championHash` so far. */
  evaluatedCountFor(championHash: string): number {
    return this.proposedAgainst.get(championHash)?.size ?? 0
  }

  /**
   * True iff every box point OTHER than the current champion has been proposed against it — i.e. the
   * next propose() will return null and the loop may emit the `converged` certificate. The current
   * champion is always one box point, so full coverage is boxSize - 1.
   */
  coverageCompleteFor(champion: StrategyGenome): boolean {
    return this.evaluatedCountFor(canonicalGenomeHash(champion)) >= this.boxSize - 1
  }

  /**
   * The convergence certificate the loop reads when propose() returns null: true iff the CURRENT
   * standing champion has full box coverage — every other box point was proposed against it and (since
   * an accept would have promoted away and reset coverage) none was accepted. This is a "no box point
   * is acceptable against the standing champion" certificate, NOT a global North-Star optimum (with
   * guards/golden conditions a higher-North-Star point can be vetoed and still leave the champion the
   * best ACCEPTABLE point). Tracked per champion hash, so a mid-sweep promotion cannot falsely certify.
   */
  isConverged(): boolean {
    return this.coverageCompleteFor(this.championStore.current())
  }

  propose(context: ProposerContext): CandidateChange | null {
    const champion = this.championStore.current()
    const championHash = canonicalGenomeHash(champion)
    const tried = this.proposedAgainst.get(championHash) ?? new Set<string>()

    for (const point of this.boxOrder) {
      const genome = this.genomeFor(point)
      const genomeHash = canonicalGenomeHash(genome)
      if (genomeHash === championHash) continue // never re-propose the champion itself
      if (tried.has(genomeHash)) continue // already proposed against THIS champion (trajectory tabu)

      tried.add(genomeHash)
      this.proposedAgainst.set(championHash, tried)
      return this.candidateFor(genome, champion, point, context)
    }
    return null // per-champion coverage complete -> the loop reads `converged`
  }

  /** Build the schema-valid, content-addressed, honestly-tiered candidate for a box point. */
  private candidateFor(
    genome: StrategyGenome,
    champion: StrategyGenome,
    point: BoxPoint,
    context: ProposerContext,
  ): CandidateChange {
    const artifactRef = this.registry.register(genome)
    const riskTier = deriveRiskTier(genome).tier

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
          `box move: (cadence ${champion.parameters.rsvp_reminder_cadence}, spacing ` +
          `${champion.parameters.reminder_spacing}) -> (cadence ${point.cadence}, spacing ` +
          `${point.spacing}) (iteration ${context.iteration}; ${context.lessons.length} prior lesson(s)).`,
      },
      change: {
        change_type: this.spec.change_type,
        summary: `cadence ${point.cadence}, spacing ${point.spacing} for ${this.spec.target_capability}.`,
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

  /** A genome at a box point, with a deterministic id (id is inert to the content hash). */
  private genomeFor(point: BoxPoint): StrategyGenome {
    return {
      genome_id: `g_search_c${point.cadence}_s${point.spacing}`,
      parameters: { rsvp_reminder_cadence: point.cadence, reminder_spacing: point.spacing },
    }
  }

  /**
   * The fixed spread-first order over the box: generate every point in row-major (cadence outer,
   * spacing inner), then visit them in ascending bit-reversed-index order (van der Corput base 2). The
   * order is independent of the champion, so the search fills the box rather than hugging the champion.
   */
  private buildBoxOrder(): readonly BoxPoint[] {
    const cadenceMin = this.spec.cadenceMin ?? 0
    const cadenceMax = this.spec.cadenceMax ?? 3
    const spacingMin = this.spec.spacingMin ?? 0
    const spacingMax = this.spec.spacingMax ?? 3

    const rowMajor: BoxPoint[] = []
    for (let cadence = cadenceMin; cadence <= cadenceMax; cadence += 1) {
      for (let spacing = spacingMin; spacing <= spacingMax; spacing += 1) {
        rowMajor.push({ cadence, spacing })
      }
    }
    const bits = Math.max(1, Math.ceil(Math.log2(rowMajor.length)))
    return rowMajor
      .map((point, index) => ({ point, key: bitReverse(index, bits), index }))
      // Sort by the scrambled key; the original index is a stable tie-break (bit-reversal of a
      // power-of-two-sized box is already a bijection, so ties only arise when the box is padded).
      .sort((a, b) => a.key - b.key || a.index - b.index)
      .map((ranked) => ranked.point)
  }
}
