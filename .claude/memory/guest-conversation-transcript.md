---
name: guest-conversation-transcript
description: Phase 38 — the read-only per-conversation chronological transcript; the total (at,G,seq) comparator + no-oracle sub-selection
metadata:
  type: project
---

Phase 38 (ADR 0038) gave the product surface a READ-ONLY per-conversation **chronological transcript** of ONE
guest escalation — the question + every reply turn (operator AND the Phase-35 bi-directional `guest` follow-ups)
+ every status transition (resolved/dismissed/reopened, who+when), **interleaved by time**. It is the read-side
legibility companion to the whole Phase 26–37 conversation arc ([[multi-turn-reply-thread]],
[[guest-reply-thread-correlation]], [[escalation-status-transition-model]], [[guest-followup-auto-reopen]]) and,
like [[account-home-overview]], a **pure web-layer composition** of the existing scoped read
`GET /t/:slug/escalations` (`{escalations, resolutions, replies}`). NO new schema (manifest stays **21**), NO new
JSON endpoint, NO new domain code. Route: `GET /t/:slug?view=escalations&conversation=<escalation_id>`, linked
from each inbox row ("View full conversation →"). Two new render fns in `product/src/web/pages.ts`
(`buildConversationTimeline` + `renderConversation` + `renderConversationNotFound`) and `#conversationPage` in
`product/src/web/product_web_ui.ts`. doddy design + built-code both APPROVE. 1006 tests.

## The load-bearing insights (carry forward)

- **The transcript order is a TOTAL lexicographic tuple `(at, G, seq)`**, `G = {question:0, reopened:1, reply:2,
  resolved|dismissed:3}`. Primary `at` (ISO strings sort chronologically) is correct whenever the clock advanced
  (production). The `(G, seq)` tiebreak only disambiguates same-instant ties and is causally faithful to the two
  REAL same-instant flows: Phase-37 auto-reopen writes the `reopened` transition STRICTLY before the guest reply
  (so reopen G1 < reply G2 — renders before the turn it enabled), and Phase-28 reply-then-resolve (reply G2 <
  close G3 — a close follows the dialogue).
- **Do NOT use a context-dependent comparator (the trap).** The first design proposal — "same-source ties by
  `seq`, group order only cross-source" — is NON-TRANSITIVE: `{T_close(seq5), R(seq0), T_reopen(seq6)}` at equal
  `at` cycles `T_reopen < R < T_close < T_reopen`, an inconsistent JS comparator → implementation-defined `sort`.
  A plain lexicographic tuple can never be inconsistent. The architect proposed the bad rule and, shown the
  cycle, withdrew it.
- **The tuple's one "mis-order" is UNREACHABLE in production.** A same-instant `resolved`→`reopened` renders
  reopen-before-close regardless of `seq` — but no synchronous context writes two transitions at one `at` (the
  ONLY two `transition()` call sites are the operator route, one-per-request, and the inbound branch, one
  `reopened` + a *reply*); `SystemClock` always advances. A CHARACTERIZATION test freezes that don't-care so it
  is never silently implementation-defined; e2e tests advance the `ManualClock` between distinct operator actions
  (expose `clock` from the web test `makeWorld`).
- **The transcript renders RAW history and computes NO effective status.** It shows every transition as its own
  event (the un-folded story), so it deliberately does NOT reuse `effectiveTransitionByEscalation`/`isEffectiveOpen`
  (the inbox/home max-`seq` fold). If a current-status summary is ever added it MUST come from that shared fold,
  never from "the last timeline event" (the display comparator's `G`-order is not the effective fold).
- **`buildConversationTimeline(escalation, resolutions, replies)` takes the escalation OBJECT** (type-enforces the
  join key) and joins resolutions/replies on `escalation.escalation_id` (server data), NEVER the client
  `?conversation=` string — it owns the filter (single-sourced, like `countOpenEscalations`).
- **No-oracle sub-selection (the trust boundary).** `#conversationPage` issues the SAME ONE scoped
  `GET /escalations` read and selects the escalation by id FROM the already-scoped array (the `conversation`
  value is a pure filter key, never an independent lookup). An id not in scope covers BOTH absent AND a couple
  probing a sibling-wedding's escalation IDENTICALLY (the scoped read already excluded the foreign row) → a
  **frozen themed-200 "no such conversation" notice** with ZERO interpolation of the client value.
- **Themed-200 notice, NOT `GENERIC_404` (subtle).** `renderDetail` masks a non-owned wedding id to `GENERIC_404`
  because THERE the JSON read returns non-200. HERE the scoped read returned 200 (tenant proven active), so the
  miss is a sub-selection, not a tenant decision; `GENERIC_404` is the *unknown-tenant* mask and would be leakier
  + an in-request inconsistency. Themed-200 is disclosure-equivalent to the inbox the principal already reached.
- **Read-only this rung = zero CSRF/mutation surface** (no forms, no token). DEFERRED: reply-on-transcript (a
  guest-auto-reopened conversation is effective-open and needs a reply, but actions stay on the inbox; adding
  them re-opens the CSRF surface and needs its own review).
