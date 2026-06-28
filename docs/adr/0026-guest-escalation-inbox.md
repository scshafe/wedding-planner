# ADR 0026 — Guest-escalation inbox (give `escalated` a real downstream surface)

- **Status:** accepted
- **Date:** 2026-06-27
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-27-phase-26-guest-escalation-inbox.md`)
- **Scope:** Phase 26 — record a guest's `escalated` question (one the platform could not answer) in a per-tenant,
  wedding-scoped inbox, and let the couple (their wedding) + planner (whole tenant) READ it (JSON `GET
  /t/:slug/escalations` + a themed `?view=escalations` page). Closes the guest→couple loop. **Read-only;**
  resolution/dismissal, routing `refused`, and reply-from-the-inbox are deferred.
- **Builds on** the guest-messaging channel ([[guest-messaging-channel-is-a-roadmap-goal]]): the inbound edge
  ([[guest-messaging-inbound-edge]]), the responder's `escalated`/`refused` outcomes
  ([[richer-guest-visible-facts]]), and the couple-scope pattern ([[couple-scoped-guest-management]]). Reuses the
  one safety model — no new safety machinery.

## Context

Before this rung, when a guest texted an UNANSWERABLE question — a logistics fact was unset
(`venue`/`parking`/`dress_code` absent) or the topic was `unknown` — the responder returned `escalated`, the
inbound edge sent nothing, and the message **vanished**: `escalated` (and `refused`) produced the uniform 202 and
left **no product-side record**. The couple/planner never learned a guest asked something the AI could not answer.
A dead end in the channel, and (since Phase 25's clear-to-absent makes a deliberately-blanked fact re-escalate)
freshly motivated.

Two adversarial reviews ran on the DESIGN (via `general-purpose` agents carrying the persona lens — the named
specialists are not provisioned here): **doddy APPROVE-WITH-FIXES** and **rigorous-architect APPROVE-WITH-FIXES**,
**no constructible exploit found**. All fixes folded in before building (see §6). 820 tests green (was 798).

## Decisions

### 1. Record `escalated` ONLY — NEVER `refused` (the no-oracle keystone)

`refused` is the surprise/secret outcome, **fact-independent by construction** (the frozen `REFUSED` constant,
read no wedding data — the property [[richer-guest-visible-facts]] relies on for COMMS.SURPRISE_LEAK). The capture
predicate is exactly `outcome.action === 'escalated'`. Recording `refused` would (a) persist guest surprise-probe
content for exactly the topic the system is designed never to engage, and (b) give the couple nothing actionable.
It is **safe to omit**: the guest's wire is unchanged (escalated and refused both still produce the uniform 202;
the record is written server-side and is visible ONLY to the already-authorized couple/planner), so "a refused
probe never appears in my inbox" is observable to no one who could exploit it. `answered` sends a reply (unchanged)
and records nothing; `refused` stays silent-and-unrecorded.

### 2. `text` is UNTRUSTED guest input — stored for the trusted couple, HTML-escaped at render, never reflected to the guest

The responder's doddy-F3 rule (a reply never echoes the inbound `text` back to the *guest*) is about guest-facing
reflection; storing the question for the *trusted couple/planner* to read is different and is the whole point. The
couple-facing HTML render passes `text` through the existing `html` SafeHtml template (Phase-14 escaping — all five
metacharacters, text + attribute contexts, no raw bypass); the JSON API returns it as an inert JSON string value.
There is no path back to the guest. Tests assert an XSS payload in `text` is escaped in the rendered bytes (unit +
e2e) and never appears raw.

### 3. `guest_escalation.text` is byte-identical to `inbound_webhook.text` (no 500 oracle)

`inbound_webhook.text` is `minLength:1` with **no maxLength**, so `guest_escalation.text` is too. Every field
`EscalationLog.record` writes is sourced from values already validated upstream (`from_ref`/`text`/
`provider_message_ref` by the inbound webhook; `wedding_id` from the trusted binding; `received_at` port-stamped),
so the `assertValid` can never be provoked to throw by guest input that passed the inbound edge. The capture is
therefore NOT swallowed to 202 — a `record()` throw is a genuine bug (honest 500), not a guest-reachable oracle.

### 4. Idempotency by `provider_message_ref` — the receipt-log pattern reused, NOT the receipt log widened

`EscalationLog` keys its own `TenantScopedRepository` by `provider_message_ref` — the SAME
provider-ref-as-dedup-key-within-the-tenant-partition pattern `inbound_receipt_log.ts` uses. `record()` is
read-first-put-if-absent, so a re-delivered inbound records exactly one escalation with a stable `escalation_id`.
We do NOT mark the receipt log for an escalation — it stays the pristine doddy-P0 "refs we charged a reply for"
store. The two logs dedup DIFFERENT side effects (a charged reply vs a recorded escalation) on DIFFERENT commit
timing. One pattern applied twice, not a second mechanism. (Considered and rejected: generalizing the receipt log
to "handled refs" — it would two-mean its store and bolt a meaningless `reply_id` onto escalations.)

### 5. Couple read scope is the EXISTING `GuestAuthorizer.manageScope` — no new authorizer

The inbox scopes exactly like the guest list: planner `{kind:'all'}` → `escalations.list`; couple
`{kind:'wedding', wedding_id}` (from the MINTED principal, never the body) → `escalations.listForWedding` (a
partition filter, oracle-free, mirroring `guest_registry.listForWedding`, incl. `undefined → []`). Read-only: GET →
scoped list; any other method → 405; auth runs before the method check (route shape is not a pre-auth oracle); an
unknown tenant masks to the same generic 404. The web page **delegates** through this JSON read
(`api.handle(bearerGet('/t/:slug/escalations'))`) — it holds NO `escalations` dep, preserving the
`@canonical product_web_ui` "only DATA path is `api.handle()`" invariant.

## Mechanics

- **19th schema** `guest_escalation` (`escalation_id`/`tenant_id`/`wedding_id`/`from_ref`/`text`/`received_at`/
  `provider_message_ref`). Manifest + count test + gen-script header 18→19; `gen:types` emits `GuestEscalation`.
- **`EscalationLog`** — a thin face over `TenantScopedRepository<GuestEscalation>` keyed by `provider_message_ref`,
  ctor `(liveness, ids)`. `record` (idempotent) / `list` (planner) / `listForWedding` (couple).
- **Capture** in `handleInbound`: on `escalated`, `escalations.record({...message/binding fields})` then the
  unchanged uniform 202; `answered`/`refused` record nothing.
- **Read** — `GET /t/:slug/escalations` via `dispatchEscalations` (minimal `EscalationHandlerDeps { escalations,
  authorizer }`, optional on `ProductApiDeps` like `messaging`); a read-only themed `?view=escalations` page
  (`renderEscalations`, no CSRF — mirrors the strategy page) linking each row to the wedding's edit form.
- **Compose** wires ONE `EscalationLog` into both the inbound capture and the read deps; exposed on
  `ComposedSurface`. A compose e2e proves the loop: a guest asks "where do I park?" (escalated, meter 0) → the
  couple sees it in `?view=escalations` → fills `parking_info` via the edit form → the same question is now
  answered (meter 1).

## §6 Review fixes folded in

- **F1 (load-bearing, both lenses):** the web page must delegate via `api.handle(bearerGet(...))` and mask every
  non-200 with the existing non-data renderer — NO `escalations` dep on the web UI (its `@canonical` invariant).
- **F2 (doddy):** `received_at` uses the `minLength:1` timestamp convention (any non-empty string passes; the port
  stamps `clock.now()`); the `EscalationLog` unit test records the REAL port-stamped value, not a literal.
- **F3 (architect):** the read deps bag is minimal `{ escalations, authorizer }` — no `weddings`.
- **F4:** documented the `manageScope` reuse (escalation-visibility scope == guest-management scope).
- **F5:** also fixed the count-test title prose + gen-script header string; the on-disk drift guard auto-checks 19.
- **F6:** pinned the future resolution shape — a SEPARATE append-only record keyed by `escalation_id` (preserving
  the escalation record's immutability), NOT a mutation of `guest_escalation`.

## Consequences

- The guest-messaging channel now has a real feedback loop: an unanswerable question surfaces the gap to the
  people who can close it. The inbox tells the couple WHICH fact to fill.
- The escalation record is an immutable historical fact ("it WAS unanswerable at the time"). A re-delivery that now
  answers (because the fact was filled) records no new escalation and leaves the old one in place — accurate.
- **Deferred:** escalation resolution/dismissal (the pinned separate-record shape), routing `refused` to the couple
  (the honest "decline vs route-to-couple" divergence), reply-from-the-inbox (a console-initiated metered send),
  and a `topic` field on the record (would widen `GuestQaOutcome`). See the plan's out-of-scope.

Memory: [[guest-escalation-inbox]].
