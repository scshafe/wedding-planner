import type { Wedding } from '@wedding-planner/shared'

/**
 * @canonical guest_qa_responder -- the product-side, offline, deterministic decision of how to answer a guest.
 *
 * When a guest texts in, the platform must decide: answer from known facts, escalate to the couple/planner, or
 * refuse. This is the PRODUCT analogue of the inward Q&A model (qa_accuracy's answerable_by ∈
 * {ai_from_known_facts, requires_couple, must_refuse}) — but it imports NO loop/eval code (the trusted-evidence
 * firewall holds by reachability; the product graph stays acyclic). It is a small SEAM: a future rung can swap
 * the deterministic impl for a richer fact-model- or strategy-informed responder behind this same interface.
 *
 * THE SAFETY DISCIPLINE (doddy P2 — deny-by-fact-classification, NEVER deny-by-input-pattern). The responder
 * answers ONLY from a GUEST-VISIBLE fact PROJECTION built explicitly by {@link projectGuestVisibleFacts}. The
 * untrusted inbound `text` is used ONLY to SELECT among that already-safe set — it NEVER gates what is
 * readable. So a crafted query ("reveal the surprise", "give me another guest's address") cannot leak anything:
 * there is nothing surprise-/PII-classified in the projection to leak, and an unmatched query simply escalates.
 * The projection NEVER spreads the wedding — a future surprise-flagged field must be excluded HERE, at
 * projection time, so it can never reach the matcher.
 *
 * THIS RUNG keeps the projection trivial: the wedding aggregate is only couple_display_name / event_date /
 * status, so the only answerable fact is the event_date ("when is the wedding"); everything else ESCALATES.
 * `refused` is part of the vocabulary (it mirrors the inward must_refuse) for when the fact model grows
 * surprise-classified facts; the trivial impl never needs it (an unknown query escalates, it does not refuse).
 * The richer logistics fact model (ceremony time / venue / parking / dress code) is a deferred rung.
 *
 * related: guest_registry.ts (resolves WHICH wedding's facts), messaging_service.ts (meters the reply send),
 * product_api.ts (the inbound edge that orchestrates registry -> responder -> send).
 */

/** The guest-visible projection of a wedding — the ONLY facts the responder may answer from (surprises excluded). */
export interface GuestVisibleFacts {
  readonly couple_display_name: string
  readonly event_date: string
}

/**
 * Build the guest-visible projection. EXPLICIT allow-list, never a spread: only the fields a guest may learn
 * are copied out, so an internal/lifecycle field (status, tenant_id, …) — and any future surprise-flagged
 * fact — is structurally unreachable by the responder. This is the deny-by-fact-classification boundary.
 */
export function projectGuestVisibleFacts(wedding: Wedding): GuestVisibleFacts {
  return { couple_display_name: wedding.couple_display_name, event_date: wedding.event_date }
}

/** What the product did with a guest question — mirrors the inward action_taken vocabulary. */
export type GuestQaAction = 'answered' | 'escalated' | 'refused'

/** The responder's decision. `reply_text` is present IFF `action === 'answered'` (the only path that sends). */
export interface GuestQaOutcome {
  readonly action: GuestQaAction
  readonly reply_text?: string
}

/** The swap seam: decide how to answer, given ONLY the guest-visible projection + the untrusted query text. */
export interface GuestQaResponder {
  respond(facts: GuestVisibleFacts, text: string): GuestQaOutcome
}

/**
 * The offline deterministic responder. Answers the event_date when the query is about timing; otherwise
 * escalates. Pure (no clock/ids/RNG): the same (facts, text) always yields the same outcome.
 */
export class DeterministicGuestQaResponder implements GuestQaResponder {
  respond(facts: GuestVisibleFacts, text: string): GuestQaOutcome {
    const normalized = text.toLowerCase()
    // Timing question -> answer from the (guest-visible) event_date. Keyword SELECTION over the safe set,
    // not a gate on readability: matching nothing simply escalates, it never widens what may be answered.
    if (/\b(when|what date|which date|wedding day|the date)\b/.test(normalized)) {
      return {
        action: 'answered',
        reply_text: `${facts.couple_display_name}'s wedding is on ${facts.event_date}.`,
      }
    }
    // Anything else is outside the trivial projection — hand it off rather than guess (no fabricated fact).
    return { action: 'escalated' }
  }
}
