import { type StrategyGenome } from '../contracts/contract_types'
import { getSchemaRegistry } from '../contracts/schema_registry'
import { sha256Hex } from '../crypto/hashing'
import { canonicalJson } from '../serialization/canonical_json'

/**
 * @canonical genome -- the content-address binding for a strategy genome.
 *
 * The genome is the offline analogue of "the change that lives in the branch a
 * candidate_change.artifact_ref points to". For the firewall to cover the thing that ACTUALLY changes
 * behavior (not just a reviewed label), a candidate must cryptographically commit to exactly the
 * genome that will run: `artifact_ref = genomeArtifactRef(genome)`. The simulator recomputes the hash
 * from the resolved genome and refuses to run on mismatch (see eval-harness planner_simulator). The
 * same hash is the lessons-dedupe key, so the proposer never re-proposes a behavior-equal loser.
 *
 * The hash is computed over `parameters` ONLY — two genomes are behavior-equal (and therefore
 * content-address-equal) iff their parameters are equal, regardless of `genome_id`. Hashing the id
 * too would let a proposer alias one behavior under unlimited ids and defeat the dedupe key.
 *
 * LOAD-BEARING PRECONDITION (doddy, Phase-2 Step-1 review): the hash is a faithful proxy for "the
 * reviewed behavior" ONLY over the schema-legal value space. Every enforcement caller MUST
 * `assertValidGenome` the genome BEFORE hashing / matching / risk-tiering — otherwise an unmapped
 * parameter the simulator reads but the risk map never saw rides along inside a stable hash (binding
 * evasion through the unvalidated door). Validation is part of the binding, not a nicety upstream of
 * it. Corollary invariants for later steps: (1) `genome_id` stays behaviorally inert — never an input
 * to the simulator, the risk map, or any branch; (2) a new parameter must be an integer/enum/bounded
 * value, or `canonicalJson` (which does NOT normalize number representation or NFC-normalize strings)
 * must be extended first; (3) a MALFORMED/MISMATCH ref is refuse-and-halt, never "regenerate the ref".
 *
 * related: shared/serialization/canonical_json.ts, shared/crypto/hashing.ts, contracts/strategy_genome.
 */

/** The `artifact_ref` scheme prefix for a content-addressed genome. */
export const GENOME_ARTIFACT_REF_PREFIX = 'genome:'

/** Validate `genome` against the strategy_genome contract, returning the typed value or throwing. */
export function assertValidGenome(genome: unknown): StrategyGenome {
  return getSchemaRegistry().assertValid<StrategyGenome>('strategy_genome', genome)
}

/**
 * The canonical content hash of a genome: sha256 over the canonical-JSON of its `parameters` (id
 * excluded by design). Deterministic and key-order-independent — two genomes with the same parameter
 * values produce the same hash regardless of property insertion order or genome_id.
 */
export function canonicalGenomeHash(genome: StrategyGenome): string {
  return sha256Hex(canonicalJson(genome.parameters))
}

/** The content-addressed artifact_ref a candidate carries to commit to exactly this genome. */
export function genomeArtifactRef(genome: StrategyGenome): string {
  return `${GENOME_ARTIFACT_REF_PREFIX}${canonicalGenomeHash(genome)}`
}

/**
 * The outcome of checking a genome against a committed `artifact_ref`. Three states, deliberately
 * distinguished so an enforcement caller cannot collapse `malformed_ref` into "regenerate the ref and
 * proceed" (which would re-derive the ref from whatever is about to run and always match — a no-op
 * firewall). `mismatch` = a genome substitution; `malformed_ref` = not a `genome:` content-address at
 * all. Both are refuse-and-halt for the simulator.
 */
export type GenomeArtifactRefVerdict = 'match' | 'mismatch' | 'malformed_ref'

/**
 * Classify a candidate's `artifact_ref` against `genome`. PRECONDITION: `genome` must already be
 * schema-valid (see this module's load-bearing precondition). The simulator refuses to run on any
 * verdict other than `match`.
 */
export function classifyGenomeArtifactRef(
  genome: StrategyGenome,
  artifactRef: string,
): GenomeArtifactRefVerdict {
  if (!artifactRef.startsWith(GENOME_ARTIFACT_REF_PREFIX)) {
    return 'malformed_ref'
  }
  return artifactRef === genomeArtifactRef(genome) ? 'match' : 'mismatch'
}

/**
 * Convenience boolean over {@link classifyGenomeArtifactRef}: true iff the ref is the content-address
 * of `genome`. Enforcement paths should prefer `classifyGenomeArtifactRef` so they can refuse-and-halt
 * distinctly on `mismatch` vs `malformed_ref` (see the verdict type).
 */
export function genomeMatchesArtifactRef(genome: StrategyGenome, artifactRef: string): boolean {
  return classifyGenomeArtifactRef(genome, artifactRef) === 'match'
}
