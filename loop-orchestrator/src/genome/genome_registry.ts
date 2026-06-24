import {
  assertValidGenome,
  canonicalGenomeHash,
  genomeArtifactRef,
  parseGenomeArtifactRef,
  type StrategyGenome,
} from '@wedding-planner/shared'

/**
 * @canonical genome_registry -- the content-addressed store that resolves a candidate's artifact_ref
 * back to the genome it committed to.
 *
 * The proposer registers a genome (and emits a candidate whose artifact_ref is that genome's
 * content-address); the loop resolves the candidate's artifact_ref here to get the genome the
 * simulator must run. Keyed by content hash, so resolution IS the binding check: a ref resolves to a
 * genome iff some registered genome hashes to it. Injected (a plain in-memory Map), never a stateful
 * singleton — that keeps the loop deterministic and replayable (rigorous-architect).
 *
 * Registration validates the genome (the weld) before hashing, so an invalid genome can never be
 * stored or resolved. Resolution of a non-`genome:` ref or an unregistered hash returns undefined —
 * refuse-and-halt for the caller, never a cue to fabricate a genome.
 *
 * related: champion_store.ts, proposer/, eval-harness planner_simulator.ts (re-verifies the ref).
 */
export class GenomeRegistry {
  private readonly byHash = new Map<string, StrategyGenome>()

  /**
   * Register a genome and return the artifact_ref a candidate must commit to. Idempotent: registering
   * a behavior-equal genome (same parameters) maps to the same ref. Validates before hashing.
   */
  register(genome: StrategyGenome): string {
    const valid = assertValidGenome(genome)
    this.byHash.set(canonicalGenomeHash(valid), valid)
    return genomeArtifactRef(valid)
  }

  /** Resolve a candidate's artifact_ref to the registered genome, or undefined if not a known ref. */
  resolve(artifactRef: string): StrategyGenome | undefined {
    const hash = parseGenomeArtifactRef(artifactRef)
    if (hash === null) {
      return undefined
    }
    return this.byHash.get(hash)
  }

  /** Whether a genome with this artifact_ref has been registered. */
  has(artifactRef: string): boolean {
    return this.resolve(artifactRef) !== undefined
  }
}
