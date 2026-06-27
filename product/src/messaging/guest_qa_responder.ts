import type { Wedding } from '@wedding-planner/shared'

/**
 * @canonical guest_qa_responder -- the product-side, offline, deterministic decision of how to answer a guest.
 *
 * When a guest texts in, the platform decides: answer from known facts, escalate to the couple/planner, or
 * refuse. This is the PRODUCT analogue of the inward Q&A model (qa_accuracy's answerable_by ∈
 * {ai_from_known_facts, requires_couple, must_refuse}) — but it imports NO loop/eval code (the trusted-evidence
 * firewall holds by reachability; the product graph stays acyclic). It is a small SEAM: a future rung can swap
 * the deterministic impl for a richer fact-model- or strategy-informed responder behind {@link GuestQaResponder}.
 *
 * THE SECURITY BOUNDARY IS THE PROJECTION, NOT THE CLASSIFIER (doddy F1+F2). The responder answers ONLY from a
 * GUEST-VISIBLE fact projection built by {@link projectGuestVisibleFacts} — an EXPLICIT allow-list, never a
 * spread, so a surprise-flagged or PII or lifecycle field (status, tenant_id, …) is *structurally* unreachable.
 * The untrusted inbound `text` only SELECTS among that already-safe set ({@link classifyTopic}); it NEVER gates
 * what is readable (deny-by-fact-classification, NEVER deny-by-input-pattern). So even a surprise probe phrased
 * to dodge the keyword classifier (and thus misclassified as a logistics/unknown topic) can leak NOTHING — there
 * is no surprise content in the projection to leak. The keyword classifier is therefore best-effort UX; the real
 * control is the allow-list. A future rung that models surprise content MUST exclude it HERE, at projection time.
 *
 * THE `refused` OUTCOME IS FACT-INDEPENDENT BY CONSTRUCTION (the load-bearing no-oracle property). A "surprise/
 * secret" question is refused UNCONDITIONALLY, for EVERY wedding, reading ZERO wedding data: `respond` returns
 * the frozen module-level {@link REFUSED} constant WITHOUT touching `facts`. This is why the wedding aggregate
 * has NO surprise field — there is no per-wedding surprise state to branch on, so refuse cannot become an
 * existence oracle. A CONDITIONAL refuse (decline iff this wedding has a surprise) would let a guest learn a
 * surprise exists from the differing reply — the exact thing COMMS.SURPRISE_LEAK forbids ("must not reveal OR
 * EVEN CONFIRM the surprise exists"). At the wire, the inbound edge sends ONLY on `answered`, so `refused` and
 * `escalated` both produce the same uniform 202 with no reply — a surprise probe is wire-indistinguishable from
 * any unanswerable question. `refused` is a real, asserted internal classification + the honest seam for a
 * future "decline vs route-to-couple" divergence; it carries no guest-visible reply this rung.
 *
 * REPLIES ARE BUILT FROM TRUSTED FACTS ONLY (doddy F3). A reply interpolates ONLY projected (schema-validated)
 * fact values — it NEVER echoes the untrusted inbound `text` back to the guest.
 *
 * THE LOGISTICS DISCLOSURE SPLIT. Ceremony time / venue / parking / dress code are guest-shareable by
 * definition. timing ALWAYS answers (event_date is required, so it is always present; ceremony_time rides the
 * answered-CONTENT channel — the timing reply always sends, and its body merely varies on ceremony_time
 * presence). venue/parking/dress_code answer-if-present, else ESCALATE — so their absence is wire-silent. Both
 * disclose only non-sensitive logistics state, which is the point of the channel. (F6: the timing asymmetry is
 * deliberate; do not "harmonize" timing into the escalate-when-absent path without re-checking this note.)
 *
 * related: guest_registry.ts (resolves WHICH wedding's facts), messaging_service.ts (meters the reply send),
 * product_api.ts (the inbound edge that orchestrates registry -> responder -> send).
 */

/**
 * The guest-visible projection of a wedding — the ONLY facts the responder may answer from. EXPLICIT allow-list:
 * `event_date` is always present (schema-required); the logistics fields are optional. NO surprise/PII/lifecycle
 * field is here — that exclusion is the deny-by-fact-classification boundary, and it is the real security control.
 */
export interface GuestVisibleFacts {
  readonly couple_display_name: string
  readonly event_date: string
  readonly ceremony_time?: string
  readonly venue_name?: string
  readonly parking_info?: string
  readonly dress_code?: string
}

/**
 * Build the guest-visible projection. EXPLICIT allow-list, never a spread: only the fields a guest may learn are
 * copied out (and optional ones only when present), so an internal/lifecycle field — and any future
 * surprise-flagged fact — is structurally unreachable by the responder. This is the deny boundary.
 */
export function projectGuestVisibleFacts(wedding: Wedding): GuestVisibleFacts {
  return {
    couple_display_name: wedding.couple_display_name,
    event_date: wedding.event_date,
    ...(wedding.ceremony_time === undefined ? {} : { ceremony_time: wedding.ceremony_time }),
    ...(wedding.venue_name === undefined ? {} : { venue_name: wedding.venue_name }),
    ...(wedding.parking_info === undefined ? {} : { parking_info: wedding.parking_info }),
    ...(wedding.dress_code === undefined ? {} : { dress_code: wedding.dress_code }),
  }
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
 * The topics a guest message can SELECT. 'surprise' routes to the fact-independent refuse; the logistics topics
 * route to answer-if-present; 'timing' always answers; 'unknown' escalates. Selection is by the untrusted text,
 * but the topic only chooses among already-safe outcomes — it never widens what is readable.
 */
type GuestTopic = 'surprise' | 'parking' | 'dress_code' | 'timing' | 'venue' | 'unknown'

/** Per-topic keyword predicates, evaluated in PRIORITY ORDER (first match wins) by {@link classifyTopic}. */
const TOPIC_PATTERNS: ReadonlyArray<readonly [GuestTopic, RegExp]> = [
  // Surprise FIRST: any surprise/secret mention refuses, even co-occurring with a logistics keyword
  // ("is there a surprise at the venue?" -> refused, not venue). This is the priority that COMMS.SURPRISE_LEAK needs.
  ['surprise', /\b(surprise|surprises|secret|secrets)\b/],
  // parking before venue so "where do I park" is parking, not venue (both could match "where").
  ['parking', /\b(park|parking)\b/],
  ['dress_code', /\b(dress|dress code|attire|wear|outfit)\b/],
  ['timing', /\b(when|what time|which date|what date|the date|wedding day|start time|begin|ceremony time)\b/],
  ['venue', /\b(where|venue|location|address|place|held)\b/],
]

/** Classify the untrusted text into a topic by first-match priority; no match -> 'unknown' (escalates). */
function classifyTopic(text: string): GuestTopic {
  const normalized = text.toLowerCase()
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(normalized)) return topic
  }
  return 'unknown'
}

/**
 * The fact-independent refuse outcome (frozen, module-level). Returned WITHOUT reference to `facts` so the
 * no-oracle property — "refuse reads no wedding data" — is enforced by construction, not by convention.
 */
const REFUSED: GuestQaOutcome = Object.freeze({ action: 'refused' })
/** The fact-independent escalate outcome (frozen, module-level) — no reply is sent for an escalation. */
const ESCALATED: GuestQaOutcome = Object.freeze({ action: 'escalated' })

/** Answer a logistics fact when present, else escalate. Reply text is built from the TRUSTED value only. */
function answerIfPresent(value: string | undefined, phrase: (value: string) => string): GuestQaOutcome {
  return value === undefined ? ESCALATED : { action: 'answered', reply_text: phrase(value) }
}

/**
 * The offline deterministic responder. Pure (no clock/ids/RNG): the same (facts, text) always yields the same
 * outcome. Every reply interpolates ONLY projected fact values; none echoes the untrusted `text`.
 */
export class DeterministicGuestQaResponder implements GuestQaResponder {
  respond(facts: GuestVisibleFacts, text: string): GuestQaOutcome {
    switch (classifyTopic(text)) {
      // Refuse reads NO `facts` — fact-independent by construction (the frozen constant). See the header note.
      case 'surprise':
        return REFUSED
      // Timing ALWAYS answers: event_date is schema-required (always present); ceremony_time rides the
      // answered-content channel (appended only when set). No absent-fact branch is possible here.
      case 'timing':
        return {
          action: 'answered',
          reply_text: facts.ceremony_time === undefined
            ? `${facts.couple_display_name}'s wedding is on ${facts.event_date}.`
            : `${facts.couple_display_name}'s wedding is on ${facts.event_date} at ${facts.ceremony_time}.`,
        }
      case 'venue':
        return answerIfPresent(facts.venue_name, (v) => `${facts.couple_display_name}'s wedding will be held at ${v}.`)
      case 'parking':
        return answerIfPresent(facts.parking_info, (v) => `Parking: ${v}`)
      case 'dress_code':
        return answerIfPresent(facts.dress_code, (v) => `The dress code is ${v}.`)
      // Outside the projection — hand off rather than guess (no fabricated fact).
      case 'unknown':
        return ESCALATED
    }
  }
}
