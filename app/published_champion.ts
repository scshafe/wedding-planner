import { deriveRiskTier, type StrategyGenome } from '@wedding-planner/shared'

/**
 * @canonical published_champion -- the committed snapshot of the self-improvement loop's champion strategy,
 * injected at the entrypoint so the product surface can show it to a planner (Phase 17, the engine↔surface seam).
 *
 * HONESTY (load-bearing): this is a HAND-COMMITTED SNAPSHOT, not a live read of the loop's in-process champion
 * store. The genome below is exactly the tier-1 optimum the offline loop converges to on its reference
 * landscape (provenance: loop-orchestrator/tests/loop/genome_keystone.test.ts:269 — cadence 3, spacing 1,
 * batching 1). A live publish pipeline (the loop writing this artifact, the surface reading it) is a deliberate
 * deferred thread; until then the value is updated by hand with cited provenance. The product surface consumes
 * this as an injected VALUE — it never imports loop-orchestrator/eval-harness, so the acyclic-workspace and
 * determinism rails hold unchanged.
 *
 * The artifact lives in `app/` (the impure entrypoint layer) because that is the one place that names a
 * specific champion to inject, exactly as it injects the clock / ids / operator token. Putting it in `product/`
 * would wrongly imply the surface owns the champion; putting it in `shared/` would imply the loop publishes it
 * as a contract (it does not, yet).
 *
 * related: strategy_guidance.ts (the projection the surface renders), compose.ts (the inject point),
 * shared/src/strategy/risk_tier.ts (the trusted tier derivation behind the fail-closed assertion below).
 */
export const publishedChampion: StrategyGenome = {
  genome_id: 'published_champion_v1',
  parameters: {
    rsvp_reminder_cadence: 3,
    reminder_spacing: 1,
    reminder_batching: 1,
  },
}

/**
 * Re-derive the genome's authoritative tier (the trusted derivation, never a declared field) and refuse any
 * strategy above tier-1. Only the tier-1 strategy the autonomous loop auto-lands may be published as the active
 * default; a tier-2+ strategy is human-approval-gated and must NEVER be silently presented as applied. Fail
 * closed (throw) so the entrypoint aborts boot before any socket opens — identical discipline to the
 * operator-token policy. `deriveRiskTier` validates the genome first, so an invalid genome also throws here.
 */
export function assertTier1Champion(genome: StrategyGenome): StrategyGenome {
  const { tier } = deriveRiskTier(genome)
  if (tier !== 1) {
    throw new Error(
      `Refusing to publish a non-tier-1 strategy as the active default (derived tier ${tier}). Only the ` +
        'tier-1 strategy the autonomous loop auto-lands may be published; a tier-2+ strategy requires human approval.',
    )
  }
  return genome
}
