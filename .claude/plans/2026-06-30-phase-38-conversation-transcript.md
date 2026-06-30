# Phase 38 — guest-conversation transcript surface (make the bi-directional channel legible)

## Goal

Give the couple/planner a per-conversation **chronological transcript** of ONE guest escalation: the original
question, every reply turn (operator AND guest, the Phase-35 bi-directional thread), and every status
**transition** (resolved / dismissed / reopened — with who + when), **interleaved by time** into a single
timeline. The Phase 26–37 arc built all this machinery (inbox → resolution → multi-turn reply thread → operator
reopen → guest-correlation → guest auto-reopen) but renders it as scattered Open/Handled rows; the conversation's
*story* — especially a guest re-engaging a resolved thread (Phase 37) — is not legible anywhere. This rung makes
it legible.

It is the product-surface legibility rung of [[guest-messaging-channel-is-a-roadmap-goal]], the read-side
companion to [[multi-turn-reply-thread]] / [[escalation-status-transition-model]] / [[guest-followup-auto-reopen]],
and follows the [[account-home-overview]] precedent: a **pure web-layer composition** of an already-gated read.

## Scope discipline (what this is NOT)

- **NO new schema, NO new JSON endpoint, NO new domain code.** The data is already returned by the scoped
  `GET /t/:slug/escalations` (`{escalations, resolutions, replies}`, all carrying timestamps:
  `received_at` / `resolved_at` / `sent_at`). The transcript is a render-time projection — like the Phase-33 home
  and the Phase-30/32 billing summary. Manifest stays **21**.
- **READ-ONLY this rung.** No reply/resolve/reopen forms on the transcript page (those stay on the inbox). The
  transcript is a legibility surface with a "← Back to all questions" link and a "Set the missing details →"
  link to the wedding. Actions-on-transcript (and the PRG-redirect-back-to-conversation it implies) are a
  documented follow-up — keeping this rung's CSRF/mutation surface at ZERO.

## The two design cruxes

### Crux 1 — the chronological interleave + deterministic tiebreak (the substance)

Build ONE time-ordered timeline for the selected escalation from three sources with INDEPENDENT seq-spaces:
the **question** (singleton), **replies** (ordered by their own `seq`), **transitions** (ordered by their own
`seq`). Timestamps are ISO-8601 UTC strings (lexicographically chronological). `ManualClock` advances only when
told, so **equal-timestamp ties are common in tests and possible in production** → the comparator must be
deterministic AND causally faithful.

- **Primary sort:** ascending `at` (ISO string compare). Correct whenever the clock advanced between events
  (the production reality).
- **Tiebreak (equal `at`)** — a fixed group order that matches the two known same-instant flows:
  - group 0: **the question** (always first; written before any reply/transition can exist).
  - group 1: **`reopened` transitions** — a reopen ENABLES the dialogue that follows, so it precedes a
    same-instant reply (matches Phase-37 "reopen STRICTLY before thread", written in one synchronous block →
    identical timestamp).
  - group 2: **replies** (ascending `seq`).
  - group 3: **`resolved` / `dismissed` transitions** — a close FOLLOWS the dialogue that prompted it, so it
    follows a same-instant reply (matches Phase-28 reply-then-resolve).
  - within a group: ascending `seq`.
  This is a small, documented comparator. Production clocks advance (group order never triggers there); the
  group order only disambiguates same-instant fixtures, and does so causally. **Step 0 review decides whether
  this status-aware tiebreak is worth the cleverness vs. a flat "replies-before-transitions" rule** (the flat
  rule visibly mis-orders the Phase-37 auto-reopen flow we just built, so the lean is to keep it status-aware).

### Crux 2 — the no-oracle conversation selection (the safety boundary)

The page issues the SAME ONE `api.handle(GET /t/:slug/escalations)` read (scoped by `manageScope`: planner →
whole tenant; couple → their bound wedding) and **selects the escalation by id FROM the already-scoped
`escalations` array** — never an independent lookup. Consequences:

- read non-200 → `#renderNonData` (byte-identical masking as every other page; unknown/suspended/unauthenticated
  all mask identically).
- read 200 but the `conversation` id is **not in the scoped array** — covers BOTH "absent" AND "a couple probing
  a sibling-wedding's escalation" identically (the scoped read already excluded the foreign one) → **ONE frozen
  themed "no such conversation" render** (the recommended default; disclosure-equivalent to the inbox, which any
  authenticated principal reaches; reveals nothing about other weddings; absent ≡ foreign by construction).
  **Step 0 review confirms** themed-200-notice vs. `GENERIC_404` (the `renderDetail` precedent for a non-owned
  per-resource id) — lean is the themed-200 notice (home/inbox stay themed-200; the read already proved the
  tenant active, so a `GENERIC_404` would be an in-request inconsistency, not extra safety).
- the `conversation` id is a CLIENT-supplied value used ONLY to FILTER the in-scope arrays (resolutions/replies
  filtered to the matched escalation_id) — never to widen reach; a smuggled/foreign id is inert (selects nothing
  in scope → the not-found notice). This mirrors the home's "discloses strictly the union of the scoped reads".

## Safety properties to preserve

- **Only-data-path-is-`api.handle`.** The web UI gains NO new dependency; the transcript reads the same JSON body
  the inbox already reads. (`#conversationPage` calls `this.#api.handle(bearerGet(...))` exactly like
  `#escalationsPage`.)
- **No new oracle.** Discloses strictly the UNION of what `GET /escalations` already discloses to this principal
  (Crux 2). The `conversation` filter cannot cross scope.
- **XSS-safe.** Guest `text` and `body` are UNTRUSTED; rendered as escaped TEXT via the `html` SafeHtml template
  (exactly as `renderEscalations` already does). `from_ref`, timestamps, `resolved_by`, `sender` likewise.
- **Trust-faithful sender labels.** Reuse the EXHAUSTIVE three-way `senderLabel` (guest / planner / couple) — a
  guest turn is never mislabeled as the couple (the Phase-35 trust-presentation rule).
- **Determinism.** No ambient time/RNG; the timeline is a pure function of the (already-deterministic) read.

## Steps

- [ ] **Step 0 — Design review (doddy + architect lenses).** Two `general-purpose` agents carrying the persona
  lens (the named specialists are not provisioned here — handoff). doddy: attack Crux 2 (can a couple learn a
  foreign/absent conversation exists? can the `conversation` filter widen disclosure? XSS round-trip? any 500
  oracle from a malformed id?). architect: validate Crux 1 (is the status-aware tiebreak correct + worth it, or
  prefer the flat rule? is `buildConversationTimeline` the right seam? does open-count / inbox single-sourcing
  stay intact — the transcript must NOT re-derive effective status differently from `effectiveTransitionByEscalation`).
  Fold findings into the steps; record the tiebreak + masking decisions here.

- [ ] **Step 1 — The pure timeline + render function (`pages.ts`).**
  - `buildConversationTimeline(escalation, resolutions, replies)` → an ordered `readonly ConversationEvent[]`
    (discriminated union: `{kind:'question'|'reply'|'transition', at, ...}`), using the Crux-1 comparator.
    `resolutions`/`replies` are the FULL scoped arrays; the builder filters each to `escalation.escalation_id`
    itself (so the caller passes the read body verbatim; the builder owns the join — single-sourced).
  - `renderConversation(theme, slug, escalation, resolutions, replies)` → themed page rendering the timeline as a
    chronological list (each event: a time-stamped line; question/reply/transition visually distinguished),
    the "← Back to all questions" + "Set the missing details →" links. All values via `html`.
  - Reuse `senderLabel`; reuse the SAME effective-status vocabulary (no divergent fold).
  - Unit tests for `buildConversationTimeline`: ordering by timestamp; the Phase-37 same-instant
    reopen-before-guest-reply tie; the Phase-28 reply-before-resolve tie; multi-reply seq order; filters out
    OTHER escalations' rows; empty thread / never-handled escalation.
  - Green (`npm run build && npm test && npm run lint`).

- [ ] **Step 2 — The web route + inbox link (`product_web_ui.ts` + `pages.ts`).**
  - `#console`: when `view==='escalations'` AND `queryParam(req.path,'conversation') !== undefined` →
    `#conversationPage(req, slug, conversationId)`; else the existing inbox. (Keeps the 2-seg console route; no
    new path segment.)
  - `#conversationPage`: ONE scoped `GET /escalations` read; non-200 → `#renderNonData`; 200 → select the
    escalation by id from the scoped array; found → `renderConversation(...)`; not-found → the frozen themed
    "no such conversation" notice (Crux 2 decision). Read-only ⇒ no CSRF issuance needed.
  - `renderEscalations`: add a "View full conversation →" link to each row (open AND handled) →
    `/t/${slug}?view=escalations&conversation=${escalation_id}`.
  - Green.

- [ ] **Step 3 — Web / e2e tests (mirror the source path).**
  - couple sees the transcript ONLY for their own wedding's conversation; a couple requesting a sibling-wedding's
    escalation id gets the byte-identical not-found notice (Crux 2 no-oracle: foreign ≡ absent).
  - planner sees any conversation in the tenant.
  - the rendered transcript shows the question, the threaded turns AND the transition history interleaved (an
    end-to-end fixture that resolves then guest-auto-reopens (Phase 37) → the timeline shows
    question → reply → resolved → guest follow-up → reopened in order, with the reopen before the guest turn at
    the same instant).
  - unauthenticated / unknown-tenant / suspended → masked exactly as the inbox.
  - the inbox row's "View full conversation →" link is present and points at the right id.
  - Green.

- [ ] **Step 4 — Docs.** ADR 0038 (the transcript surface, the two cruxes + their resolved decisions, the
  read-only/follow-up boundary); memory [[guest-conversation-transcript]] + MEMORY.md index; tick these boxes;
  refresh `.claude/handoff.local.md` (Phase 38 complete; next levers). Commit per step.

## Verification

`npm run build && npm test && npm run lint` green before every box tick and commit (run build/lint standalone,
check exit codes — never pipe through tail/grep when `&&`-gating; this is zsh, use `$pipestatus` or
`cmd > /tmp/x.log 2>&1; echo $?`). Per-step commits on `build/phase-38-conversation-transcript`.
