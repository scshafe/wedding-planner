import type { GuestPersona } from '@wedding-planner/shared'

import { type ScenarioDefinition } from '../scoring/offline_scorer'

/**
 * @canonical domain_facts -- the SHARED ground-truth FACTS of the RSVP world, read by BOTH simulator
 * stages. This module is the one place the line "share the FACT, never the CLAIM" is drawn (Phase 4b,
 * rigorous-architect C2 + doddy P1-3).
 *
 * Stage A (the planner, claims) and Stage B (the harness, trusted record) must agree on the ground
 * truth of the world — how many reminders a latency needs, and which guests the COUPLE can personally
 * resolve — or the integrity gate would diverge on honest runs. So those FACTS live here and both
 * stages import them. But each stage applies the genome POLICY to these facts BY ITS OWN computation:
 * Stage A authors product events (and a LYING Stage A may deviate), Stage B authors the trusted record.
 * Nothing here authors a claim or a trusted record, and Stage B never imports Stage A's event-emission
 * path — so a bug in one stage cannot corrupt both identically and re-vacuum the gate. Sharing the
 * domain CONSTANT is safe; sharing the claim path would not be.
 *
 * related: stage_a_planner.ts (policy → claims), stage_b_observer.ts (policy → trusted record).
 */

/** Sentinel for a guest who never responds to AI reminders regardless of cadence/spacing. */
export const NEVER = Number.POSITIVE_INFINITY

/**
 * Reminders a guest needs before they resolve via NUDGES, from their ground-truth `response_latency`.
 * A `never` responder cannot be resolved by reminders at any cadence (only, possibly, by the couple).
 */
export const REMINDERS_NEEDED: Readonly<Record<string, number>> = {
  immediate: 0,
  after_one_reminder: 1,
  after_multiple_reminders: 2,
  never: NEVER,
}

/**
 * The ground-truth set of guests the COUPLE can personally resolve when the planner escalates them
 * (the `rsvp_truth.couple_resolvable` persona fact). This is a SCENARIO fact, genome-free: the genome
 * decides the escalation POLICY, this decides who is actually resolvable. A guest absent from this set
 * cannot have their resolution manufactured by an escalation — claiming otherwise is a forge.
 */
export function coupleResolvableGuestIds(scenario: ScenarioDefinition): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const guest of scenario.guests) {
    if (isCoupleResolvable(guest)) {
      ids.add(guest.persona_id)
    }
  }
  return ids
}

/** Whether one guest is ground-truth couple-resolvable (defaults to false when the fact is absent). */
export function isCoupleResolvable(guest: GuestPersona): boolean {
  return guest.rsvp_truth.couple_resolvable === true
}

/**
 * Reminder-window capacity by spacing level: how many nudges fit in the fixed rsvp_window (the reach
 * fact). SHARED so Stage A's claim and Stage B's trusted record agree on which guests reminders alone
 * resolve. The flat-then-sharp shape [3,3,1,0] is the tuned Phase-3 profile pinned by the metamorphic
 * matrix — see stage_a_planner.ts for the modeling rationale; this is the single source of the values.
 */
const SPACING_CAPACITY: readonly number[] = [3, 3, 1, 0]

/** Nudges that fit in the window at a spacing level (capped reach; 0 past the table). */
export function spacingCapacity(spacing: number): number {
  return SPACING_CAPACITY[spacing] ?? 0
}

/**
 * PHASE-5 reminder_batching FACT — the digest-consolidation operator, SHARED by both stages so Stage A's
 * claim and Stage B's trusted record agree on which guests reminders resolve under batching. digestSize is
 * the number of reminders bundled into one send: `batching + 1` (0 => 1 => no consolidation => identity).
 * Both `effectiveNudges` and `feltTouches` are the SAME `ceil(x / digestSize)` digest operator applied to
 * the two existing per-guest quantities — and both collapse to the identity at batching 0 (digestSize 1,
 * `ceil(x/1) === x`), so the whole Phase-3 model is preserved unchanged on the b=0 slice.
 */
export function digestSize(batching: number): number {
  return Math.max(1, batching + 1)
}

/**
 * REACH dilution (the batching downside): a bundled digest lands as ONE effective nudge toward a guest's
 * ground-truth need. So `delivered` scheduled reminders carry only `ceil(delivered / digestSize)` effective
 * nudges — a guest resolves iff this still meets its `needed`. Manufactures no resolution (a never-responder
 * still never resolves; this only ever REDUCES effective reach). Stage B applies this identical calc.
 */
export function effectiveNudges(delivered: number, batching: number): number {
  return delivered <= 0 ? 0 : Math.ceil(delivered / digestSize(batching))
}

/**
 * COMFORT consolidation (the batching upside): the `received` reminders a guest actually got are bundled
 * into `ceil(received / digestSize)` felt interruptions — fewer felt touches => fewer nags => gentler
 * guest_sentiment_score.
 */
export function feltTouches(received: number, batching: number): number {
  return received <= 0 ? 0 : Math.ceil(received / digestSize(batching))
}

/**
 * The most reminders a guest is comfortable receiving before it reads as nagging.
 *
 * EXPLICIT MODELING DECISION (testineer, Phase-2 Step-4 review): COMFORT_CAP is a UNIVERSAL comfort
 * ceiling, INDEPENDENT of how many reminders a guest's latency required — `nags = feltTouches -
 * min(needed, COMFORT_CAP)`. So a slow responder who needed 2 reminders is charged 1 nag for the
 * second even though it's what converted them: a 2nd+ reminder mildly annoys even when it works. The
 * alternative (`max(needed, COMFORT_CAP)` — only reminders BEYOND a guest's need nag) was rejected
 * because it makes the guard bite ONLY on never-responders, leaving a flat gradient whenever every
 * guest is reachable. The universal-ceiling choice gives the loop a real gradient even without an
 * unreachable guest — which is the property that makes the cadence tradeoff worth optimizing.
 */
export const COMFORT_CAP = 1
/** Sentiment lost per nagging reminder at spacing 0 (a guest starts at 1.0, floored at 0). */
const SENTIMENT_PENALTY_PER_NAG = 0.25
/**
 * Fraction by which each spacing level softens a nag: penalty_per_nag = SENTIMENT_PENALTY_PER_NAG *
 * (1 - SPACING_RELIEF * spacing). At 0.25 the per-nag penalty is {0.25, 0.1875, 0.125, 0.0625} for
 * spacing {0,1,2,3} — strictly positive across the band (the guard never goes free), and exactly the
 * Phase-2 value at spacing 0.
 */
const SPACING_RELIEF = 0.25

/** The comfort ceiling for a guest whose latency `needed` reminders (0 for a never-responder). */
export function comfortCeiling(needed: number): number {
  return needed === NEVER ? 0 : Math.min(needed, COMFORT_CAP)
}

/** Sentiment lost per nag at a spacing level (the spacing upside: gentler with more spacing). */
export function penaltyPerNag(spacing: number): number {
  return SENTIMENT_PENALTY_PER_NAG * (1 - SPACING_RELIEF * spacing)
}

/**
 * PHASE-6 the SHARED guest-sentiment FACT — the honest `guest_sentiment_score` for one guest under a
 * (spacing, batching) policy, given the ground-truth primitives BOTH stages compute independently:
 * `needed` (persona latency), `delivered = min(cadence, spacingCapacity(spacing))`, and `resolved`
 * (`effectiveNudges(delivered,batching) >= needed`). A resolved guest stops at `needed` reminders; an
 * unresolved one receives the full `delivered`. Those reminders are FELT as `feltTouches` interruptions
 * (the batching comfort upside), each beyond `comfortCeiling` a nag, each nag gentler at higher spacing.
 *
 * This is the trusted backing for `guest_sentiment_score`, which the scorer computes over the CLAIMED
 * `guest.sentiment.sampled` stream (Phase-6). Stage A applies it and EMITS the claim; Stage B applies it
 * and RECORDS the trusted observation — neither imports the other's path, so the integrity gate can veto
 * a forged/inflated/suppressed sentiment claim. Because both stages call THIS pure function on the same
 * primitives, their results are BIT-IDENTICAL, so the gate's exact-equality field diff never
 * false-positives on an honest run (a stronger guarantee than dyadic constants — it holds by shared
 * computation). At batching 0 (digestSize 1) feltTouches is the identity, preserving the Phase-3 model.
 */
export function honestSentimentScore(
  needed: number,
  delivered: number,
  resolved: boolean,
  spacing: number,
  batching: number,
): number {
  const remindersSent = resolved ? needed : delivered
  const nags = Math.max(0, feltTouches(remindersSent, batching) - comfortCeiling(needed))
  return Math.max(0, Math.min(1, 1 - penaltyPerNag(spacing) * nags))
}

/**
 * The true couple attention (seconds) one escalate-to-couple consumes — the per-escalation cost feeding
 * couple_active_minutes_total → effort_cost. A flat per-escalation cost keeps the value/cost tradeoff
 * legible: more escalations resolve more guests but spend proportionally more couple attention. SHARED
 * so Stage A's claimed `active_seconds` and Stage B's trusted cost agree on the honest run.
 */
export const COUPLE_SESSION_ACTIVE_SECONDS = 600

/**
 * How many still-pending, couple-resolvable guests the planner escalates to the couple WITHOUT asking,
 * by `autonomy_threshold` (the tier-2 commitment-autonomy knob). Higher threshold = more autonomous
 * escalation = more couple-resolutions AND more couple cost (the monotone tradeoff the oracle pins).
 * `Infinity` at 3 = escalate every pending couple-resolvable guest. This is a POLICY mapping over a
 * shared datum; each stage applies it to the pending set by its own slicing computation.
 */
export function escalationBudget(autonomyThreshold: number): number {
  if (autonomyThreshold >= 3) {
    return Number.POSITIVE_INFINITY
  }
  return Math.max(0, autonomyThreshold)
}
