import type {
  EventEnvelope,
  GuestPersona,
  IdGenerator,
  ManualClock,
  StrategyGenome,
} from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'

import { type ScenarioDefinition } from '../scoring/offline_scorer'
import {
  COUPLE_SESSION_ACTIVE_SECONDS,
  effectiveNudges,
  escalationBudget,
  feltTouches,
  isCoupleResolvable,
  NEVER,
  REMINDERS_NEEDED,
  spacingCapacity,
} from './domain_facts'

/**
 * @canonical stage_a_planner -- STAGE A of the planner simulator: the product's self-report.
 *
 * Stage A is "the planner": it consumes (scenario, genome) and emits ONLY product events (claims) via
 * the injected clock + id generator. It is the offline stand-in for running the product at a genome.
 * It writes NOTHING to the TrustedRecorder — that is Stage B's job, and the separation is the whole
 * point (rigorous-architect, Phase-2): if one function authored both the events AND the trusted
 * record, INTEGRITY.SELF_REPORT_DIVERGENCE would be vacuous (the two sources could never disagree).
 * Keeping Stage A claims-only keeps that gate load-bearing even for a simulator.
 *
 * The default planner models RSVP behavior from PERSONA GROUND TRUTH (`guest.rsvp_truth`), so the
 * genome->metric relationship is non-circular: more reminder cadence resolves guests whose
 * `response_latency` needs nudging (rsvp_resolution_rate up), but reminders past a guest's comfort
 * nag them (guest_sentiment_score, the paired guard, down). That tradeoff is a real property of the
 * model, not a number the test restates.
 *
 * PHASE-3 SECOND KNOB — `reminder_spacing` (the temporal twin of cadence). It is FORGE-FREE by
 * construction: a guest still resolves ONLY if its ground-truth need is met (`needed <= delivered`),
 * so the planner never manufactures a resolution — which is exactly why this knob adds NO new
 * self-report-divergence surface and Stage B needs no new observation (see stage_b_observer.ts and
 * memory: second-genome-knob-must-stay-tier1). Spacing does two things, a real upside AND a real
 * downside, which is what makes the (cadence, spacing) landscape NON-SEPARABLE with an interior
 * optimum rather than a corner:
 *   - DOWNSIDE: more spacing fits FEWER nudges in the fixed rsvp_window — delivered = min(cadence,
 *     capacity(spacing)) — so high spacing caps reach and can leave a reachable guest unresolved.
 *   - UPSIDE: more spacing makes each delivered nudge GENTLER — penalty_per_nag falls with spacing —
 *     so the sentiment hit per nag shrinks. The sentiment term is therefore MULTIPLICATIVE
 *     (penalty(spacing) * nags(cadence)); the optimal cadence depends on spacing, and vice versa.
 * At spacing 0 the model is identical to Phase 2 (capacity(0) >= cadence_max, penalty == base), so the
 * Phase-2 anchored oracle values are preserved unchanged.
 *
 * PHASE-5 THIRD KNOB — `reminder_batching` (the delivery-grouping analogue of spacing). digestSize =
 * batching + 1. Also FORGE-FREE: resolution still requires the ground-truth need met. Two-sided, via the
 * SHARED digest fact (domain_facts.ts), and the SAME `ceil(x/digestSize)` operator on the two existing
 * quantities — so batching 0 (digestSize 1) reduces EXACTLY to the Phase-3 model and the b=0 matrix slice
 * is byte-identical:
 *   - DOWNSIDE (reach dilution): a bundled digest lands as one effective nudge — resolution requires
 *     effectiveNudges(delivered, batching) = ceil(delivered/digestSize) >= needed. Stage B applies the
 *     IDENTICAL calc (it reads batching too), so honest runs agree and the integrity gate stays load-bearing.
 *   - UPSIDE (comfort consolidation): feltTouches(remindersSent, batching) = ceil(remindersSent/digestSize)
 *     fewer felt interruptions => fewer nags => gentler sentiment (a claimed-only signal; Stage B ignores it).
 * The (cadence, spacing, batching) landscape is NON-SEPARABLE in 3-D: the optimal cadence depends on
 * batching (the digest dilutes reach, so a higher cadence is needed to resolve a multi-reminder guest once
 * its nudges are bundled) — pinned by the 3-D matrix test (metamorphic_oracle.test.ts).
 *
 * related: stage_b_observer.ts (the independent trusted record), planner_simulator.ts (wiring).
 */

/** Everything Stage A needs to emit a scenario's product events for one genome. */
export interface PlannerInput {
  readonly scenario: ScenarioDefinition
  readonly genome: StrategyGenome
  /** ManualClock (not the Clock interface) — the planner advances it between events. */
  readonly clock: ManualClock
  readonly ids: IdGenerator
}

/** Stage A: a pure mapping from (scenario, genome) to product events (claims only). */
export type Planner = (input: PlannerInput) => readonly EventEnvelope[]

// NEVER + REMINDERS_NEEDED are the SHARED ground-truth facts (domain_facts.ts) — Stage B reads the
// same constants so honest runs agree; each stage applies the genome policy by its own computation.

/**
 * The most reminders a guest is comfortable receiving before it reads as nagging.
 *
 * EXPLICIT MODELING DECISION (testineer, Phase-2 Step-4 review): COMFORT_CAP is a UNIVERSAL comfort
 * ceiling, INDEPENDENT of how many reminders a guest's latency required — `nags = remindersSent -
 * min(needed, COMFORT_CAP)`. So a slow responder who needed 2 reminders is charged 1 nag for the
 * second even though it's what converted them: a 2nd+ reminder mildly annoys even when it works. The
 * alternative (`max(needed, COMFORT_CAP)` — only reminders BEYOND a guest's need nag) was rejected
 * because it makes the guard bite ONLY on never-responders, leaving a flat gradient whenever every
 * guest is reachable. The universal-ceiling choice gives the loop a real gradient even without an
 * unreachable guest — which is the property that makes the cadence tradeoff worth optimizing.
 */
const COMFORT_CAP = 1
/** Sentiment lost per nagging reminder at spacing 0 (a guest starts at 1.0, floored at 0). */
const SENTIMENT_PENALTY_PER_NAG = 0.25

/**
 * PHASE-3 reminder_spacing constants. Tuned so the (cadence, spacing) North-Star surface has a genuine
 * INTERIOR, NON-SEPARABLE optimum on the keystone corpus — pinned by the 16-value matrix test, never
 * by editing the North Star weights. At spacing 0 both reduce to the Phase-2 model. The reminder-window
 * CAPACITY profile [3,3,1,0] is the shared reach fact (domain_facts.ts `spacingCapacity`), so Stage B's
 * trusted record agrees with Stage A's claims on which guests reminders resolve.
 */
/**
 * Fraction by which each spacing level softens a nag: penalty_per_nag = SENTIMENT_PENALTY_PER_NAG *
 * (1 - SPACING_RELIEF * spacing). At 0.25 the per-nag penalty is {0.25, 0.1875, 0.125, 0.0625} for
 * spacing {0,1,2,3} — strictly positive across the band (the guard never goes free), and exactly the
 * Phase-2 value at spacing 0.
 */
const SPACING_RELIEF = 0.25

/** Sentiment lost per nag at a spacing level (the spacing upside: gentler with more spacing). */
function penaltyPerNag(spacing: number): number {
  return SENTIMENT_PENALTY_PER_NAG * (1 - SPACING_RELIEF * spacing)
}

/** The rsvp_status a resolved guest reports, from their ground-truth intent. */
function resolvedStatus(guest: GuestPersona): 'yes' | 'no' {
  return guest.rsvp_truth.will_attend === 'no' ? 'no' : 'yes'
}

interface GuestOutcome {
  readonly resolved: boolean
  readonly remindersSent: number
  readonly sentimentScore: number
}

/** Deterministically resolve one guest's RSVP outcome under a (cadence, spacing, batching) genome. */
function guestOutcome(
  guest: GuestPersona,
  cadence: number,
  spacing: number,
  batching: number,
): GuestOutcome {
  const needed = REMINDERS_NEEDED[guest.rsvp_truth.response_latency] ?? NEVER
  // Spacing caps how many of the cadence nudges actually fit in the window (the spacing downside).
  const delivered = Math.min(cadence, spacingCapacity(spacing))
  // PHASE-5 batching: bundling DILUTES reach — `delivered` reminders carry only
  // effectiveNudges = ceil(delivered/digestSize) effective nudges toward the ground-truth need.
  // FORGE-FREE: resolution still requires the ground-truth need to be MET — never manufactured. A
  // never-responder (needed === NEVER) can never resolve regardless of the genome. (Stage B applies the
  // IDENTICAL effectiveNudges calc via the shared fact, so honest runs agree and the gate stays load-bearing.)
  const resolved = needed !== NEVER && effectiveNudges(delivered, batching) >= needed
  // A resolved guest stops receiving reminders once they respond (at `needed`); an unresolved guest
  // (still pending, or a never-responder) receives the full delivered budget.
  const remindersSent = resolved ? needed : delivered
  const comfortCeiling = needed === NEVER ? 0 : Math.min(needed, COMFORT_CAP)
  // PHASE-5 batching: bundling CONSOLIDATES interruptions — the `remindersSent` reminders are felt as
  // feltTouches = ceil(remindersSent/digestSize) interruptions, each beyond comfort a nag. At b=0 this
  // is remindersSent unchanged. (Comfort is a claimed-only signal; Stage B does not read this.)
  const nags = Math.max(0, feltTouches(remindersSent, batching) - comfortCeiling)
  // Each nag is gentler at higher spacing (the spacing upside) — the multiplicative interaction.
  const sentimentScore = Math.max(0, Math.min(1, 1 - penaltyPerNag(spacing) * nags))
  return { resolved, remindersSent, sentimentScore }
}

/** The default Stage-A planner: RSVP resolution + sentiment as a function of `rsvp_reminder_cadence`. */
export const rsvpCadencePlanner: Planner = ({ scenario, genome, clock, ids }) => {
  const cadence = genome.parameters.rsvp_reminder_cadence
  const spacing = genome.parameters.reminder_spacing
  const batching = genome.parameters.reminder_batching
  const events: EventEnvelope[] = []

  const emit = (
    eventName: string,
    capability: EventEnvelope['capability'],
    actor: EventEnvelope['actor'],
    guestId: string,
    payload: Record<string, unknown>,
  ): void => {
    events.push(
      buildEvent(clock, ids, {
        event_name: eventName,
        trace_id: `t_${scenario.scenario_id}`,
        wedding_id: scenario.scenario_id,
        phase: 'rsvp_window',
        capability,
        actor,
        source: 'eval',
        guest_id: guestId,
        payload,
        meta: { schema_version: '1.0.0' },
      }),
    )
    clock.advance(1000)
  }

  const pending: GuestPersona[] = []
  for (const guest of scenario.guests) {
    const guestId = guest.persona_id
    const outcome = guestOutcome(guest, cadence, spacing, batching)

    emit(EVENT_NAMES.guest_rsvp_requested, 'rsvp', 'ai', guestId, { guest_id: guestId })
    for (let i = 0; i < outcome.remindersSent; i += 1) {
      emit(EVENT_NAMES.guest_rsvp_reminded, 'rsvp', 'ai', guestId, { guest_id: guestId })
    }
    if (outcome.resolved) {
      emit(EVENT_NAMES.guest_rsvp_received, 'rsvp', 'guest', guestId, {
        guest_id: guestId,
        rsvp_status: resolvedStatus(guest),
      })
    } else {
      pending.push(guest)
    }
    emit(EVENT_NAMES.guest_sentiment_sampled, 'comms_personalization', 'system', guestId, {
      guest_id: guestId,
      sentiment_score: outcome.sentimentScore,
    })
  }

  emitEscalations(genome, pending, emit)
  return events
}

/**
 * PHASE 4b — escalate-to-couple (the tier-2 `autonomy_threshold` behavior). For guests still pending
 * after reminders, the planner acts on the couple's behalf WITHOUT asking: it escalates the first
 * `escalationBudget(threshold)` still-pending, couple-resolvable guests (deterministic persona order)
 * to the couple. Each escalation CLAIMS a couple session (the cost → couple_active_minutes_total) and a
 * couple-resolution (the value → rsvp_resolution_rate). Stage A computes this BY ITS OWN slicing over
 * the shared facts — Stage B re-derives the same honest set independently, and the integrity gate
 * vetoes any deviation (a forged couple-resolution / shaved cost). A genome WITHOUT `autonomy_threshold`
 * escalates nothing, so the tier-1 search box never exercises this path (the box stays tier-1).
 */
function emitEscalations(
  genome: StrategyGenome,
  pending: readonly GuestPersona[],
  emit: (
    eventName: string,
    capability: EventEnvelope['capability'],
    actor: EventEnvelope['actor'],
    guestId: string,
    payload: Record<string, unknown>,
  ) => void,
): void {
  const autonomyThreshold = genome.parameters.autonomy_threshold
  if (autonomyThreshold === undefined) {
    return
  }
  const candidates = pending
    .filter((guest) => isCoupleResolvable(guest))
    .sort((a, b) => a.persona_id.localeCompare(b.persona_id))
  const budget = escalationBudget(autonomyThreshold)
  for (let i = 0; i < candidates.length && i < budget; i += 1) {
    const guest = candidates[i] as GuestPersona
    const guestId = guest.persona_id
    // The couple spends attention resolving this guest (the escalate-to-couple cost). about_guest_id is
    // the harness-derivable join key the integrity gate reconciles the trusted cost against.
    emit(EVENT_NAMES.couple_session_ended, 'rsvp', 'couple', guestId, {
      session_id: `cs_${guestId}`,
      about_guest_id: guestId,
      active_seconds: COUPLE_SESSION_ACTIVE_SECONDS,
    })
    emit(EVENT_NAMES.guest_rsvp_received, 'rsvp', 'guest', guestId, {
      guest_id: guestId,
      rsvp_status: resolvedStatus(guest),
    })
  }
}
