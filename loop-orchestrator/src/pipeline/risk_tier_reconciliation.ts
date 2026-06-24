import {
  type CandidateChange,
  classifyGenomeArtifactRef,
  deriveRiskTier,
  type StrategyGenome,
} from '@wedding-planner/shared'

import { type GenomeRegistry } from '../genome/genome_registry'

/**
 * @canonical risk_tier_reconciliation -- the firewall gate that cross-checks a candidate's DECLARED
 * risk_tier against the tier independently DERIVED from the genome it actually runs.
 *
 * doddy's load-bearing Step-2/Step-6 invariant: the gate must NEVER trust the proposer-supplied
 * risk_tier number (relaundering the claim is not verification). It re-derives from the genome the
 * candidate content-addresses, in the order validate -> verify-ref -> derive -> reconcile:
 *   1. resolve the genome from the candidate's artifact_ref (a non-genome / unregistered ref halts);
 *   2. verify the resolved genome's content-address equals the artifact_ref (substitution halts);
 *   3. derive the authoritative tier from THAT genome (deriveRiskTier validates it first — the weld);
 *   4. an UNDER-declaration (declared < derived) is the firewall-evasion attack — reject + signal.
 *
 * Over-declaration (declared > derived) is honored (a proposer may voluntarily raise scrutiny).
 *
 * related: shared/strategy/risk_tier.ts, genome/genome_registry.ts, loop/offline_loop.ts (the caller).
 */

export type RiskTierReconciliation =
  | { readonly ok: true; readonly genome: StrategyGenome; readonly derivedTier: number; readonly declaredTier: number }
  | {
      readonly ok: false
      readonly reason: 'unresolved_ref' | 'ref_mismatch' | 'under_declared'
      readonly derivedTier: number | null
      readonly declaredTier: number
      readonly detail: string
    }

/**
 * Reconcile a candidate's declared risk_tier against the tier derived from its content-addressed
 * genome. Returns the resolved genome on success so the caller does not resolve it twice.
 */
export function reconcileCandidateRiskTier(
  candidate: CandidateChange,
  registry: GenomeRegistry,
): RiskTierReconciliation {
  const declaredTier = candidate.risk_tier
  const artifactRef = candidate.change.artifact_ref

  const genome = registry.resolve(artifactRef)
  if (genome === undefined) {
    return {
      ok: false,
      reason: 'unresolved_ref',
      derivedTier: null,
      declaredTier,
      detail: `artifact_ref '${artifactRef}' resolves to no registered genome (refuse-and-halt)`,
    }
  }

  // Defense in depth: the registry keys by hash, but verify the binding explicitly before deriving.
  if (classifyGenomeArtifactRef(genome, artifactRef) !== 'match') {
    return {
      ok: false,
      reason: 'ref_mismatch',
      derivedTier: null,
      declaredTier,
      detail: `resolved genome does not match artifact_ref '${artifactRef}' (substitution; refuse-and-halt)`,
    }
  }

  // Derive INDEPENDENTLY from the genome — never read candidate.risk_tier as authoritative.
  const derivedTier = deriveRiskTier(genome).tier
  if (declaredTier < derivedTier) {
    return {
      ok: false,
      reason: 'under_declared',
      derivedTier,
      declaredTier,
      detail: `declared risk_tier ${declaredTier} < derived ${derivedTier} (firewall-evasion signal)`,
    }
  }

  return { ok: true, genome, derivedTier, declaredTier }
}
