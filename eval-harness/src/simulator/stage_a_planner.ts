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
  honestBookingApprovalSession,
  honestCategoryStatus,
  honestQaAction,
  honestQaEscalationSession,
  honestSentimentScore,
  honestVisionConsultSession,
  honestVisionMatch,
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
 *     fewer felt interruptions => fewer nags => gentler sentiment. PHASE-6: sentiment is now a SHARED fact
 *     (honestSentimentScore) Stage B mirrors into the trusted record, so the integrity gate reconciles it.
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
  // PHASE-6: the sentiment math is the SHARED domain fact `honestSentimentScore` — Stage A applies it
  // here to EMIT the claim, Stage B applies the IDENTICAL fact to RECORD the trusted observation, and
  // the integrity gate reconciles the two (so a forged/inflated/suppressed sentiment claim is vetoed).
  const sentimentScore = honestSentimentScore(needed, delivered, resolved, spacing, batching)
  return { resolved, remindersSent, sentimentScore }
}

/** The default Stage-A planner: RSVP resolution + sentiment as a function of `rsvp_reminder_cadence`. */
export const rsvpCadencePlanner: Planner = ({ scenario, genome, clock, ids }) => {
  const cadence = genome.parameters.rsvp_reminder_cadence
  const spacing = genome.parameters.reminder_spacing
  const batching = genome.parameters.reminder_batching
  // PHASE-7: a genome can escalate Q&A to the couple iff it carries the tier-2 autonomy_threshold knob
  // (escalation consumes couple attention — the commitment_autonomy surface). A tier-1 genome answers a
  // requires_couple question itself (honest-but-incorrect). Stage B re-derives this same capability.
  const canEscalate = genome.parameters.autonomy_threshold !== undefined
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

    // PHASE-7: handle each scripted question. The honest action is `honestQaAction(answerable_by,
    // canEscalate)` — correct for ai/refuse at any tier, but only ESCALATED (correct) for a
    // requires_couple question when the genome can escalate; a tier-1 genome ANSWERS it (incorrect).
    // `answerable_by_expected` is ALWAYS emitted — the integrity gate field-diffs it with
    // skipWhenClaimAbsent:false, so an honest claim must carry it. Guests with no questions emit nothing.
    for (const question of guest.questions) {
      emit(EVENT_NAMES.guest_question_answered, 'guest_qa', 'ai', guestId, {
        guest_id: guestId,
        question_id: question.question_id,
        answerable_by_expected: question.answerable_by,
        action_taken: honestQaAction(question.answerable_by, canEscalate),
      })
      // PHASE-9: escalating a requires_couple question to the couple consumes couple attention (the cost
      // Phase 7 deferred). One couple session per honestly-escalated question, keyed by (qa_escalation,
      // question_id). Stage B re-derives the IDENTICAL session via the SAME shared fact.
      if (honestQaEscalationSession(question.answerable_by, canEscalate)) {
        emit(EVENT_NAMES.couple_session_ended, 'guest_qa', 'couple', guestId, {
          session_id: `cs_qa_${question.question_id}`,
          session_reason: 'qa_escalation',
          about_id: question.question_id,
          active_seconds: COUPLE_SESSION_ACTIVE_SECONDS,
        })
      }
    }
  }

  emitEscalations(genome, pending, emit)

  // PHASE-8: book each required category the couple needs. The honest status is
  // `honestCategoryStatus(requires_couple_approval, canEscalate)` — `booked` for an approval-free category
  // at any tier, but only `booked` (vs honest `deferred`) for an approval-required category when the genome
  // can escalate (the tier-2 commitment_autonomy surface). Category bookings are plan-scoped, not
  // guest-scoped, so they carry no guest_id. Stage B re-derives the IDENTICAL status into the trusted
  // record. A category-FREE scenario (the search corpus) has no required_categories, so ZERO category
  // events are emitted and the metric stays null — the cube pins are untouched.
  for (const required of scenario.required_categories ?? []) {
    const bookingStatus = honestCategoryStatus(required.requires_couple_approval, canEscalate)
    events.push(
      buildEvent(clock, ids, {
        event_name: EVENT_NAMES.category_booked,
        trace_id: `t_${scenario.scenario_id}`,
        wedding_id: scenario.scenario_id,
        phase: 'booking',
        capability: 'budget_management',
        actor: 'ai',
        source: 'eval',
        payload: {
          category_id: required.category_id,
          category: required.category,
          booking_status: bookingStatus,
        },
        meta: { schema_version: '1.0.0' },
      }),
    )
    clock.advance(1000)
    // PHASE-9: securing approval on a requires_couple_approval booking consumes couple attention (the
    // cost Phase 8 deferred). One couple session per honestly-approved booking, keyed by
    // (booking_approval, category_id). An approval-FREE category books autonomously with NO couple cost.
    if (honestBookingApprovalSession(required.requires_couple_approval, canEscalate)) {
      events.push(
        buildEvent(clock, ids, {
          event_name: EVENT_NAMES.couple_session_ended,
          trace_id: `t_${scenario.scenario_id}`,
          wedding_id: scenario.scenario_id,
          phase: 'booking',
          capability: 'budget_management',
          actor: 'couple',
          source: 'eval',
          payload: {
            session_id: `cs_book_${required.category_id}`,
            session_reason: 'booking_approval',
            about_id: required.category_id,
            active_seconds: COUPLE_SESSION_ACTIVE_SECONDS,
          },
          meta: { schema_version: '1.0.0' },
        }),
      )
      clock.advance(1000)
    }
    // PHASE-10: a vision-sensitive BOOKED category carries a vision-alignment claim (the only present
    // `quality` rubric, `vision_match_rate`). Aligned (1.0) only if the genome can CONSULT the couple
    // (tier-2) — which also pays a `vision_consult` couple session — else a DEFAULT (0.5) selection at no
    // cost. Orthogonal to completeness (the category is booked either way). A non-vision-sensitive category
    // (incl. EVERY search-corpus / Phase-8 category) emits NO vision claim, keeping those runs byte-identical.
    if (required.vision_sensitive === true && bookingStatus === 'booked') {
      events.push(
        buildEvent(clock, ids, {
          event_name: EVENT_NAMES.category_vision_aligned,
          trace_id: `t_${scenario.scenario_id}`,
          wedding_id: scenario.scenario_id,
          phase: 'booking',
          capability: 'budget_management',
          actor: 'ai',
          source: 'eval',
          payload: {
            category_id: required.category_id,
            vision_match_score: honestVisionMatch(canEscalate),
          },
          meta: { schema_version: '1.0.0' },
        }),
      )
      clock.advance(1000)
      if (honestVisionConsultSession(canEscalate)) {
        events.push(
          buildEvent(clock, ids, {
            event_name: EVENT_NAMES.couple_session_ended,
            trace_id: `t_${scenario.scenario_id}`,
            wedding_id: scenario.scenario_id,
            phase: 'booking',
            capability: 'budget_management',
            actor: 'couple',
            source: 'eval',
            payload: {
              session_id: `cs_vision_${required.category_id}`,
              session_reason: 'vision_consult',
              about_id: required.category_id,
              active_seconds: COUPLE_SESSION_ACTIVE_SECONDS,
            },
            meta: { schema_version: '1.0.0' },
          }),
        )
        clock.advance(1000)
      }
    }
  }

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
    // The couple spends attention resolving this guest (the escalate-to-couple cost). (session_reason,
    // about_id) is the harness-derivable composite join key the integrity gate reconciles the trusted
    // cost against (Phase 9 generalized the per-guest key so one guest can carry >1 escalation reason).
    emit(EVENT_NAMES.couple_session_ended, 'rsvp', 'couple', guestId, {
      session_id: `cs_${guestId}`,
      session_reason: 'rsvp_escalation',
      about_id: guestId,
      active_seconds: COUPLE_SESSION_ACTIVE_SECONDS,
    })
    emit(EVENT_NAMES.guest_rsvp_received, 'rsvp', 'guest', guestId, {
      guest_id: guestId,
      rsvp_status: resolvedStatus(guest),
    })
  }
}
