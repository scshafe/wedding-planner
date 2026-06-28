# ADR 0028 — Reply-from-the-inbox (console-initiated metered reply that auto-resolves)

- **Status:** accepted
- **Date:** 2026-06-28
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-28-phase-28-reply-from-inbox.md`)
- **Scope:** Phase 28 — let the couple (their wedding) / planner (whole tenant) **answer an escalated guest
  directly from the inbox**. The operator types a reply; the platform sends it to the guest's `from_ref` over
  the guest's channel through `MessagingService.send` (**metered + billed** — the FIRST time the meter fires
  from a console action, not the inbound webhook), and **auto-records a `resolved` resolution** so the
  escalation moves Open → Handled in one action ("resolve-by-replying"). JSON `POST /t/:slug/escalations` with a
  `reply_text` body + a CSRF-gated 4-seg browser Reply form.
- **Builds on** the escalation inbox + resolution ([[guest-escalation-inbox]] / [[escalation-resolution]], ADRs
  0026/0027), the metered messaging firewall ([[guest-messaging-port-and-meter]], ADR 0018), the inbound edge's
  commit-after-success ([[guest-messaging-inbound-edge]], ADR 0019), and the browser-form CSRF seam
  ([[planner-guest-management-and-csrf]], ADR 0021). Reuses the one safety model — **no new safety machinery**.

## Context

The inbox could be *read* (Phase 26) and *cleared* (Phase 27), but the only way to actually **answer** an
escalated guest was to fill the missing fact and wait for the guest to ask again. The natural close — reply to
the guest directly — was the #1 ranked next lever. It is the first **console-initiated metered send**: it
exercises the Phase-18 billing firewall from a new caller (the authenticated operator, not the provider
webhook) and so carries the same no-oracle obligation as the resolve mutation plus a real-money/real-comms
side effect.

Two adversarial reviews ran on the DESIGN, then a third on the BUILT code (via `general-purpose` agents
carrying the persona lens — the named specialists are not provisioned here): **doddy** and
**rigorous-architect** both **APPROVE-WITH-FIXES** on the design (**no constructible exploit found**); all
fixes folded in before/while building; **doddy re-review of the implementation: APPROVE, clean** (no findings).
858 tests green (was 845 after Step 1; +8 reply-API, +5 web/compose).

## Decisions

### 1. `channel` on `guest_escalation` — the reply-routing snapshot (the only schema change)

To reply over the channel the guest reached us on, the escalation must remember it. The guest registry binding
has no channel, and re-deriving is impossible at reply time — so `channel` (the canonical `Channel`, REQUIRED)
is added to `guest_escalation` and copied from the validated inbound `message.channel` at `record()` time. It
is a MODIFY of an existing schema (manifest count stays **20**, no new file), drift-guarded against the shared
`Channel` (a `GuestEscalation['channel']` `Exact<>` line in `channel.test.ts`, like the `inbound_webhook`
guard). The escalation stays immutable: the field is populated AT creation from trusted upstream state, not
mutated later. In-memory store ⇒ no migration.

### 2. The reply is SCOPED like resolve — one shared frozen miss makes the no-oracle STRUCTURAL

`handleEscalationReply` mirrors `handleEscalationResolve`'s pinned order: `getByEscalationId` (tenant-scoped
scan) → **absent** OR **a couple whose bound wedding ≠ the escalation's** → ONE shared frozen
`RESP_REPLY_MISS` (`{replied:false}`), returned BEFORE any send/charge/record. A couple cannot distinguish "no
such escalation" from "an escalation in another wedding" (an unbound couple has `wedding_id===undefined`, which
never equals a non-empty escalation `wedding_id`). Separate constant from `RESP_RESOLVE_MISS` (different body
key, `replied` vs `resolved`); a successful reply returns the distinct `{replied:true}`.

### 3. The send is gated on NO prior resolution existing (doddy F1/F2 — the load-bearing money/comms fix)

After the scope gate (so this read is never an oracle for a couple), the handler reads the resolution log
(`EscalationResolutionLog.getByEscalationId`, an O(1) read of the `escalation_id`-keyed partition): if a
resolution already exists (`resolved` OR `dismissed`) → `RESP_REPLY_MISS`, **no send**. This means (a) an
already-**dismissed** escalation can never dispatch a billed message to a guest the operator chose to ignore,
and (b) a **double-submit** with a different `reply_text` is a single send — the second attempt finds the
escalation handled and short-circuits, so the operator is honestly told `{replied:false}` rather than
`{replied:true}` for a silently-dropped second body. Reply is therefore strictly an **Open-escalation** action
(matching the UI, which shows the Reply form only on Open rows).

### 4. Deterministic meter key `reply:${escalation_id}` — single-charge by construction (defense in depth)

The send's idempotency key is the deterministic `reply:${escalation_id}` (platform-derived, never the body),
so even if the resolution gate were bypassed, `MessagingService` dedupes the send per tenant (the port is not
called again, nothing re-metered/re-billed). The `reply:` colon-prefix is disjoint from the inbound path's
`mintReplyId()` (`inbound_…` underscore-prefix), and the key is tenant-namespaced — no cross-tenant or
cross-channel collision. Unlike the inbound path (which mints a fresh key per delivery because it has no stable
caller-side key), the console reply HAS a stable trusted key (the escalation id), so deterministic is correct
and *better* for single-charge. The intended contract: the FIRST accepted reply body wins; a re-submit is a
no-op, never a second text.

### 5. Body provenance — only `escalation_id` + `reply_text` are read from the body

`channel` and `recipient_ref` come from the live escalation; `tenant_id` from the context; the resolution's
`wedding_id` is copied from the live escalation; `resolved_by` is the principal's role. A smuggled
`channel`/`recipient_ref`/`wedding_id`/`tenant_id` body field is inert. The discrimination
`body.reply_text !== undefined` is a pure function of body shape, evaluated before any field validation, so it
cannot flip a couple's parse outcome into an oracle. `reply_text` is bounded by a `REPLY_TEXT_MAX_LENGTH`
hygiene cap (trusted-operator input, not a security gate) that fires as a masked 400 BEFORE the lookup.

### 6. Commit-after-success — send then resolve

The billable external effect (`service.send`) commits FIRST; only on success does the resolution record. A
structured `WeddingPlannerError` from the send (margin/cost/unknown-tenant) returns `RESP_REPLY_MISS` — the
escalation stays Open + retryable with no resolution recorded (and the deterministic key leaves a failed send's
key free, so a retry actually re-sends). A genuine (non-structured) bug re-throws → the pipeline's constant
500. Unlike the inbound path it is NOT swallowed to a uniform 202: the caller is an authenticated operator, so
there is no oracle to protect between two authed principals — but the miss keeps the inbox actionable.

### 7. Channel is GUEST-chosen — a bounded cost-amplification, not a leak (doddy F3)

Because `channel` is the channel the guest texted in on, a guest *chooses* the reply channel, so per-channel
pricing makes the reply cost guest-influenced. This is **bounded** by the `MessagingService` strict-margin gate
(`billed > providerCost`): a non-positive-margin channel **refuses to send** (throws → escalation stays Open,
no charge). It is not a cross-tenant leak and not a guest-visible oracle (the guest already knows their own
channel). A per-tenant reply-channel policy override is a recorded future option, not built this rung. The
reply *content* is intentionally not retained inbox-side this rung (the meter + ledger record that a send
happened); a conversation transcript is a future rung.

### 8. Web: a 4-seg CSRF Reply form delegating to the 3-seg JSON route

`renderEscalations` adds a Reply form (textarea `reply_text` + hidden `escalation_id` + `_csrf`, plus the
channel shown as `via <channel>`) to each Open row. `ProductWebUi.#escalationReply` handles the 4-seg
`POST /t/:slug/escalations/reply` (slug-masked to 404 BEFORE the CSRF read; forged token → masked 403 with NO
send), then delegates to the 3-seg JSON route with `{escalation_id, reply_text}`, always PRG-redirecting (303)
back to the inbox. CSRF lives ONLY at the web layer; the JSON mutation API is Bearer-only and not
CSRF-reachable. The same `MessagingService` instance is wired into the escalations deps at compose, so a
console reply and a guest reply meter/bill through one ledger.

## Consequences

- **Positive:** the guest↔couple↔guest loop is now fully closeable from the console — an unanswerable question
  can be answered directly, and answering clears the inbox. The metered send is exercised from a second caller
  through one firewall + one ledger. No new safety machinery; the no-oracle keystone and the billing firewall
  are reused verbatim.
- **Trade-offs / deferred:** reply content is not persisted (no transcript); the reply channel is guest-chosen
  (no operator override); a reply cannot re-open a handled escalation (first-writer-wins); replying is
  Open-only by construction. Each is a recorded future rung, not an oversight.
- **Invariants to preserve:** read only `escalation_id`+`reply_text` from the body; scope gate before the
  resolution-state read before the send; one shared frozen miss; deterministic `reply:${id}` key;
  commit-after-success; CSRF at the web layer only.

See `.claude/memory/reply-from-inbox.md`, ADR 0027 (the resolution this reply records), ADR 0018 (the metered
firewall), and `.claude/plans/2026-06-28-phase-28-reply-from-inbox.md`.
