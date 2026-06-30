# ADR 0038 — Guest-conversation transcript surface

- **Status:** accepted
- **Date:** 2026-06-30
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-30-phase-38-conversation-transcript.md`)
- **Scope:** Phase 38 — a READ-ONLY, per-conversation **chronological transcript** of ONE guest escalation: the
  original question, every reply turn (operator AND the Phase-35 bi-directional `guest` follow-ups) and every
  status transition (resolved / dismissed / reopened, with who + when), interleaved by time into a single
  timeline. Reached via `GET /t/:slug?view=escalations&conversation=<escalation_id>`, linked from each inbox row.
- **Builds on** the multi-turn reply thread ([[multi-turn-reply-thread]], ADR 0034), guest-reply correlation
  ([[guest-reply-thread-correlation]], ADR 0035), the status-transition model + operator reopen
  ([[escalation-status-transition-model]], ADR 0036), and guest auto-reopen ([[guest-followup-auto-reopen]],
  ADR 0037). It is the **read-side legibility companion** to all of that machinery, and follows the
  [[account-home-overview]] (ADR 0033) precedent: a **pure web-layer composition** of an already-gated read.

## Context

Phases 26–37 built the entire bi-directional escalation conversation — inbox → resolution → multi-turn reply
thread → operator reopen → guest correlation → guest auto-reopen — but the inbox renders it as scattered
Open/Handled rows. The *story* of one conversation, especially a guest re-engaging a resolved thread (Phase 37),
was legible nowhere. The scoped JSON read `GET /t/:slug/escalations` already returns everything needed
(`{escalations, resolutions, replies}`, each carrying an ISO-8601 timestamp: `received_at` / `sent_at` /
`resolved_at`), so the transcript is a render-time projection — no new schema (manifest stays **21**), no new
JSON endpoint, no new domain code.

## Decision

### The chronological interleave + a TOTAL, transitive comparator

`buildConversationTimeline(escalation, resolutions, replies)` merges three sources with INDEPENDENT seq-spaces —
the question (singleton), replies (own `seq`), transitions (own `seq`) — into one ordered `ConversationEvent[]`
(a discriminated union normalizing each source's own timestamp field to a single `at`). It takes the escalation
**object** (so the join key is provably the trusted, in-scope `escalation.escalation_id`, never the client
`?conversation=` string) and OWNS the join (filters the full scoped arrays to that id — single-sourcing "which
rows belong to this conversation," like `countOpenEscalations`).

Order is a **total lexicographic tuple `(at, G, seq)`**, `G = {question:0, reopened:1, reply:2,
resolved|dismissed:3}`. Primary `at` (ISO strings sort chronologically) is correct whenever the clock advanced
between events — the production reality. The `(G, seq)` tiebreak only disambiguates same-instant ties, and is
**causally faithful to the two real same-instant flows**:

- a `reopened` transition (G1) precedes a same-instant `reply` (G2): the Phase-37 inbound auto-reopen writes the
  `reopened` transition STRICTLY BEFORE the guest reply turn, both from one un-advanced `clock.now()` — so the
  reopen renders before the guest turn it enabled.
- a `reply` (G2) precedes a same-instant close transition (G3): a Phase-28 console reply writes the reply, then
  (a separate action) the resolve — a close FOLLOWS the dialogue that prompted it.

**Why a total tuple, not a context-dependent rule.** The design review first proposed "same-source ties by
`seq`, group order only cross-source." That is **non-transitive**: for `{T_close(seq5), R(seq0), T_reopen(seq6)}`
at equal `at` it yields the cycle `T_reopen < R < T_close < T_reopen` (an inconsistent JS comparator →
implementation-defined `sort`). The lexicographic `(at, G, seq)` tuple can never be inconsistent. Its only
"mis-order" is a same-instant `resolved`→`reopened` (renders reopen before close regardless of `seq`), and that
is **unreachable in production**: there are exactly two `transition()` call sites (the operator route,
one-per-request; the inbound branch, one `reopened` + a *reply*), so no synchronous context writes two
transitions at one `at`; `SystemClock` always advances. A characterization test freezes that don't-care so it is
never silently implementation-defined; tests advance the clock between distinct operator actions.

### The transcript renders RAW history, computes NO effective status

The transcript shows every transition as its own event (the un-folded story), NOT the max-`seq` effective fold
the inbox/home use. So it deliberately does NOT reuse `effectiveTransitionByEscalation` / `isEffectiveOpen`.
**Invariant:** if a current-status summary is ever added, it must come from that shared fold, never from "the
last timeline event" — the display comparator's `G`-order is not the effective-status fold and could disagree in
the unreachable same-instant tie.

### No-oracle conversation selection (the trust boundary)

`#conversationPage` issues the SAME ONE `api.handle(GET /escalations)` read (scoped by `manageScope`: planner →
whole tenant, couple → their bound wedding) and selects the escalation by id FROM the already-scoped array —
never an independent lookup; the `conversation` value is a pure filter key. Consequences:

- read non-200 → `#renderNonData` (byte-identical masking as every other page).
- read 200 but the id is **not in the scoped array** — covers BOTH "absent" AND "a couple probing a
  sibling-wedding's escalation" identically (the scoped read already excluded the foreign row) → a **frozen
  themed-200 "no such conversation" notice** with ZERO interpolation of the client `conversation` value (the
  `renderDetail` "never reflect the id" rule).

**Why themed-200, not `GENERIC_404`.** `renderDetail` masks a non-owned wedding id to `GENERIC_404` because
*there the JSON read itself returns non-200*. Here the scoped read returned **200** (the tenant is proven active;
any authenticated principal reaches the inbox), so the not-found is a sub-selection miss, not a tenant decision.
`GENERIC_404` is the *unknown-tenant* mask — using it here would be leakier (it would make "valid session,
id-not-in-your-scope" look like an unknown tenant) and an in-request inconsistency. Themed-200 is
disclosure-equivalent to the inbox the principal already reached, and absent ≡ foreign by construction.

### Read-only this rung

No reply/resolve/reopen forms on the transcript ⇒ zero CSRF/mutation surface (no token issued). The
"← Back to all questions" link returns to the inbox where the actions live.

## Consequences

- **The bi-directional channel is now legible.** A guest re-engaging a resolved conversation (Phase 37) reads as
  one continuous, time-ordered story (question → reply → resolved → guest follow-up → reopened) rather than
  scattered rows — the read-side payoff of the entire Phase 26–37 arc.
- **No new oracle, no new surface.** Built-code re-review (doddy lens) APPROVE: all six attacked properties hold
  (no cross-wedding/tenant existence oracle, no disclosure widening, XSS-safe via `html`, no 500 oracle, no
  CSRF/mutation surface, total/transitive comparator).
- **Deferred — reply-on-transcript.** A guest-auto-reopened conversation is effective-OPEN and needs a reply, but
  the transcript (the surface that best surfaces "guest re-engaged") has no reply affordance this rung; the
  operator navigates back to the inbox. Actions-on-transcript (and the PRG-redirect-back-to-conversation it
  implies) is the explicit follow-up — it re-opens the CSRF surface and needs its own review.
