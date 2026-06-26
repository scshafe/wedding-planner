import { assertValidGenome, deriveRiskTier, type StrategyGenome } from '@wedding-planner/shared'

/**
 * @canonical strategy_guidance -- the engine↔surface translation: the loop's champion `StrategyGenome`
 * projected into read-only, planner-facing guidance for the product UI.
 *
 * This is the seam (Phase 17) where the inward-facing self-improvement loop finally reaches a customer.
 * The loop optimizes ONE strategy genome (the three tier-1 flow knobs) over its reference scenario corpus;
 * this module turns the converged champion into human copy a planner can read. Two load-bearing properties,
 * both mirroring the trusted-evidence firewall (the genome's risk tier is DERIVED, never declared):
 *
 *  - PURE PROJECTION OF AN ALREADY-TRUSTED VALUE. `describeStrategy` takes ONLY a `StrategyGenome` — no
 *    tenant context, no principal, no repository in scope — so the guidance is structurally wedding-agnostic
 *    and identical for every tenant and every role (it is platform-global config, not wedding-private data).
 *    It is a deterministic function of the genome alone: no I/O, no clock, no ambient state.
 *
 *  - RE-DERIVE THE TIER, NEVER TRUST A DECLARED ONE. The autonomy explanation ("applied automatically" at
 *    tier-1 vs "requires human approval" at tier-2) comes from the trusted `deriveRiskTier` (shared), which
 *    `assertValidGenome`s first and fails closed on any unmapped knob. The genome carries no self-declared
 *    tier and this module reads none. An invalid genome throws here (fail-closed) — at boot, via the eager
 *    precompute in `ProductApi`'s constructor, so a broken champion aborts boot rather than serving a partial
 *    render.
 *
 * The guidance carries ONLY human copy + the derived autonomy explanation. It deliberately exposes NONE of:
 * `genome_id`, the raw `parameters`, the content hash, the sensitivity-surface names, or any error code — a
 * planner has no use for engine lineage, and the surface must not leak it (doddy Phase-17 DP1).
 *
 * related: shared/src/strategy/risk_tier.ts (the trusted tier derivation), pages.ts (renderStrategy),
 * product_api.ts (the /t/:slug/strategy endpoint that serves this), app/published_champion.ts (the artifact).
 */

/** The planner-facing description of one strategy knob (human copy only — no engine internals). */
export interface StrategyKnobGuidance {
  /** A short human label, e.g. "RSVP reminders". */
  readonly label: string
  /** The knob's current level (0..3 for the flow knobs; 1..3 for the optional autonomy knob). */
  readonly level: number
  /** The knob's maximum level — for an "N of M" display. */
  readonly maxLevel: number
  /** A one-line, planner-facing explanation of what THIS level does. */
  readonly summary: string
}

/** The derived autonomy posture of the strategy — explained, never a raw tier number on the page. */
export interface StrategyAutonomyGuidance {
  /** The authoritative tier from the trusted derivation (kept for logic/tests; not rendered as jargon). */
  readonly tier: 0 | 1 | 2 | 3
  /** Whether the strategy is applied automatically (tier ≤ 1) or needs a human (tier ≥ 2). */
  readonly appliedAutomatically: boolean
  /** A short human label for the posture. */
  readonly label: string
  /** A one-line, planner-facing explanation of why. */
  readonly explanation: string
}

/** The full planner-facing projection of the champion strategy. A pure function of the genome. */
export interface StrategyGuidance {
  readonly headline: string
  readonly autonomy: StrategyAutonomyGuidance
  readonly knobs: readonly StrategyKnobGuidance[]
  /** The honesty rail, in customer-facing copy: platform-global, offline, NOT a per-wedding score. */
  readonly disclaimer: string
}

const HEADLINE = 'Data-optimized planning strategy'

const DISCLAIMER =
  'This is the platform’s current data-optimized planning strategy — the same defaults for every ' +
  'workspace, derived from offline evaluation. This is an offline demo where comms are simulated; these ' +
  'defaults tune the workspace’s automated planning and are not a score of any individual wedding.'

/** Words for how spread out the reminder nudges are (reminder_spacing 0..3). */
const SPACING_WORDS = ['sent close together', 'lightly spread out', 'well spread out', 'spread widely'] as const

/** Map the RSVP-reminder-cadence level to planner copy (0 = none, else "up to N"). */
function cadenceSummary(level: number): string {
  if (level <= 0) return 'No extra RSVP reminders are sent to guests who haven’t replied.'
  return `Sends up to ${level} RSVP reminder${level === 1 ? '' : 's'} to each guest who hasn’t replied yet.`
}

/** Map the reminder-spacing level to planner copy. */
function spacingSummary(level: number): string {
  const word = SPACING_WORDS[Math.max(0, Math.min(SPACING_WORDS.length - 1, level))]
  return `Reminders are ${word} across the RSVP window — more spacing reads as gentler to guests.`
}

/** Map the reminder-batching level to planner copy (digest size = level + 1). */
function batchingSummary(level: number): string {
  if (level <= 0) return 'Each reminder is sent on its own (no digest bundling).'
  return `Reminders are bundled up to ${level + 1} per digest send, so guests get fewer separate nudges.`
}

/** Map the optional tier-2 autonomy threshold to planner copy. */
function autonomySummary(level: number): string {
  return (
    `The planner may act on the couple’s behalf up to level ${level} without asking. This is elevated ` +
    'autonomy, so it is not applied automatically — a human must approve it first.'
  )
}

function autonomyGuidance(tier: 0 | 1 | 2 | 3): StrategyAutonomyGuidance {
  if (tier >= 2) {
    return {
      tier,
      appliedAutomatically: false,
      label: 'Requires human approval',
      explanation:
        'This strategy includes elevated autonomy (the planner acting on the couple’s behalf), so it is ' +
        'not applied automatically — a human approves it before it takes effect.',
    }
  }
  return {
    tier,
    appliedAutomatically: true,
    label: 'Applied automatically',
    explanation:
      'These are flow-and-timing defaults the planner applies on its own — they touch no spending, ' +
      'bookings, guest content, or personal data, so no human sign-off is needed.',
  }
}

/**
 * Project a champion `StrategyGenome` into read-only, planner-facing guidance. Validates the genome and
 * RE-DERIVES its risk tier (the firewall analogue) — never trusts a declared tier. Throws (fail-closed) on
 * an invalid or unmapped genome; callers invoke this eagerly at boot so a broken champion aborts boot.
 */
export function describeStrategy(genome: StrategyGenome): StrategyGuidance {
  const valid = assertValidGenome(genome)
  const { tier } = deriveRiskTier(valid)
  const p = valid.parameters

  const knobs: StrategyKnobGuidance[] = [
    { label: 'RSVP reminders', level: p.rsvp_reminder_cadence, maxLevel: 3, summary: cadenceSummary(p.rsvp_reminder_cadence) },
    { label: 'Reminder spacing', level: p.reminder_spacing, maxLevel: 3, summary: spacingSummary(p.reminder_spacing) },
    { label: 'Reminder bundling', level: p.reminder_batching, maxLevel: 3, summary: batchingSummary(p.reminder_batching) },
  ]
  // The tier-2 autonomy knob is OPTIONAL; only describe it when the champion actually carries it.
  if (p.autonomy_threshold !== undefined) {
    knobs.push({ label: 'Acting without asking', level: p.autonomy_threshold, maxLevel: 3, summary: autonomySummary(p.autonomy_threshold) })
  }

  return { headline: HEADLINE, autonomy: autonomyGuidance(tier), knobs, disclaimer: DISCLAIMER }
}
