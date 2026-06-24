import { assertValidGenome, canonicalGenomeHash, type StrategyGenome } from '@wedding-planner/shared'

/**
 * @canonical champion_store -- the current champion genome (the standard a candidate must beat).
 *
 * No champion concept existed before Phase 2 (rigorous-architect): in Phase 1 the "baseline" was a
 * runner-internal toggle. This introduces it as explicit, injected state — seeded with a champion
 * genome (the "current product"), the same role couple_standard_baseline plays for personas.
 *
 * OFFLINE-ONLY SIMPLIFICATION (documented, deliberate): in the full design promotion is an ONLINE
 * outcome (shadow -> canary -> ramp -> promoted); offline there is no `promoted` transition, so the
 * loop advances the champion on offline-ACCEPT — the closest legitimate signal. The champion ratchets
 * monotonically (every accepted candidate raises the bar), which is exactly real hill-climbing. The
 * champion's lineage is recorded as EVIDENCE in the append-only ledger (the genome hash on the
 * accepting transition), never as mutable state here — this store holds only "who is champion now".
 *
 * related: genome_registry.ts, loop/offline_loop.ts, ledger/ledger.ts.
 */
export class ChampionStore {
  private champion: StrategyGenome

  constructor(seed: StrategyGenome) {
    // Validate the seed (the weld): an unvalidated genome must never become the standard others run against.
    this.champion = assertValidGenome(seed)
  }

  /** The current champion genome — the baseline variant the simulator runs and the candidate must beat. */
  current(): StrategyGenome {
    return this.champion
  }

  /** The content hash of the current champion (for ledger lineage / dedupe). */
  currentHash(): string {
    return canonicalGenomeHash(this.champion)
  }

  /**
   * Advance the champion to a newly-accepted genome. Validates first. The loop calls this only after
   * the deterministic selector accepts the candidate offline (the offline-only promotion signal above).
   */
  promote(genome: StrategyGenome): void {
    this.champion = assertValidGenome(genome)
  }
}
