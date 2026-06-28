# Phase 28 — Reply-from-the-inbox (console-initiated metered reply that auto-resolves)

## Goal
Let a couple (their wedding) / planner (whole tenant) **answer an escalated guest directly from the
inbox**. The operator types a reply; the platform sends it to the guest's `from_ref` over the guest's
channel through `MessagingService.send` (**metered + billed** — the FIRST time the meter fires from a
console action, not the inbound webhook), and **auto-records a `resolved` resolution** so the escalation
moves Open → Handled in one action ("resolve-by-replying"). Closes the guest↔couple↔guest loop fully.

## The crux (carry forward)
- **The reply needs the inbound channel, which the escalation does not yet store** → add `channel` to the
  `guest_escalation` schema (required, drift-guarded against the canonical `Channel`), captured from
  `message.channel` at record time. The escalation becomes the reply-routing snapshot.
- **The reply is a real, billed side effect with the SAME no-oracle obligation as resolve.** The scope
  gate (couple → own wedding only) fires BEFORE the send: an absent escalation OR a couple's
  foreign-wedding escalation returns ONE shared frozen `RESP_REPLY_MISS` and sends/bills NOTHING (a
  couple cannot probe another wedding's escalation by observing a send). Statement order pinned: the
  `reply_text` 400 fires independent of existence.
- **Idempotent + single-charge by construction.** The meter idempotency key is the DETERMINISTIC
  `reply:${escalation_id}` (platform-derived, never the body), so a double-submit meters/dispatches once;
  the resolution is first-writer-wins keyed by `escalation_id`. Commit-after-success: send FIRST, then
  record the resolution — a send failure leaves the escalation Open and retryable (no resolution recorded).
- **CSRF at the web layer only.** A new 4-seg `POST /t/:slug/escalations/reply` browser form (CSRF-gated,
  slug-masked before CSRF) delegates to the 3-seg JSON `POST /t/:slug/escalations`, which discriminates
  reply (`reply_text` present) vs resolve (status-based). `reply_text` is the operator's body, not stored.

## Steps

- [x] **Step 0 — Adversarial design review.** doddy + architect both APPROVE-WITH-FIXES, no exploit
  found. Folding in: (F1+F2) gate the send on NO prior resolution existing (already-handled → miss, no
  send — fixes reply-to-dismissed money/comms defect AND double-submit silent-drop); (F3) channel =
  guest-chosen, margin gate bounds cost-amplification, document it; (F4) discriminate on
  `reply_text !== undefined` pinned before field validation, read only escalation_id+reply_text from
  body; (F5) maxLength cap pre-lookup; (arch5) `service` REQUIRED + fix stale "read-only" doc comment +
  same MessagingService instance at compose; (arch6) structured send failure → RESP_REPLY_MISS
  (Open+retryable), genuine bugs still 500; (arch3) reuse `resolved` enum, don't persist reply_text
  (recorded decision). Tests: channel drift guard, byte-identical reply-miss, single-charge,
  no-send-on-miss (spy), web forged-CSRF no-send. Run the doddy (security/oracle) lens + the architect lens
  over this design via `general-purpose` agents (the named specialists are not provisioned here). Focus:
  the console-send no-oracle equivalence (foreign-wedding ≡ absent, send/bill nothing), the
  deterministic-key single-charge claim, commit-after-success ordering, the channel-on-escalation
  disclosure (does storing/using channel leak anything to the guest?). Apply findings before coding.

- [x] **Step 1 — `channel` on `guest_escalation` (schema + capture).** Done; 845 tests green.
  - Add required `channel` (enum, canonical `Channel`, drift-guard description) to
    `guest_escalation_schema.json`; `npm run gen:types` (GuestEscalation gains channel). Manifest count
    stays 20 (modification, not a new schema file).
  - `RecordEscalationInput` gains `channel`; `EscalationLog.record` copies it; the inbound capture site in
    `product_api.ts` passes `message.channel`.
  - `channel.test.ts`: add the `Exact<Channel, GuestEscalation['channel']>` drift guard.
  - Update escalation fixtures/tests that construct a `GuestEscalation` to include `channel`.
  - Verify: `npm run build && npm test && npm run lint` green.

- [x] **Step 2 — Reply handler (JSON): send + auto-resolve.** Done; 853 tests green (+8 reply-API).
  - `EscalationHandlerDeps` gains `service: MessagingService`.
  - `dispatchEscalations` POST: parse body once, discriminate `reply_text !== undefined` → reply, else
    → resolve (refactor both handlers to take the parsed `body`).
  - `handleEscalationReply`: scope → `requireString` escalation_id + reply_text (+ a maxLength hygiene cap,
    400 fires before lookup) → `getByEscalationId` → absent OR couple-foreign-wedding → shared frozen
    `RESP_REPLY_MISS` (no send) → `service.send(tenant, {channel: escalation.channel, recipient_ref:
    escalation.from_ref, body: reply_text, idempotency_key: 'reply:'+escalation_id})` → on success
    `resolutions.resolve({status:'resolved', resolved_by: principal.role, wedding_id: escalation.wedding_id})`
    → `{ replied: true }`.
  - `compose.ts` wires the existing `MessagingService` into the escalations deps.
  - Tests `escalation_reply_api.test.ts`: planner-any / couple-theirs / foreign-wedding miss BYTE-identical
    to absent / no send on miss / idempotent double-reply meters once / bad-reply_text-400 independent of
    existence / channel honored / meter fired + billed / tenant isolation.
  - Verify green.

- [ ] **Step 3 — Web reply form (CSRF) + browser e2e.**
  - `pages.ts` `renderEscalations`: add a Reply form (textarea `reply_text` + hidden `escalation_id` +
    `_csrf`) to each Open escalation (alongside Resolve/Dismiss).
  - `product_web_ui.ts`: 4-seg `POST /t/:slug/escalations/reply` → slug-mask 404 → CSRF verify (forged →
    403, no send) → delegate to JSON 3-seg with `{escalation_id, reply_text}` → 303 back to inbox.
  - Tests: `escalation_web.test.ts` (forged-CSRF 403 no send / valid reply 303 → moves to Handled /
    unknown-slug 404 before CSRF); `pages.test.ts` (+ reply form present in Open, XSS still escaped).
  - `compose.test.ts` e2e: guest texts an unanswerable question → `escalated` (inbox Open) → couple replies
    via the browser form → `usageView` count++ (a metered send to the guest's from_ref over the ask
    channel) → escalation now Handled (`resolved`) → a re-reply is a no-op (meter count unchanged).
  - Verify green.

- [ ] **Step 4 — ADR 0028 + memory + handoff.** Write ADR 0028; add
  `.claude/memory/reply-from-inbox.md` + index it; update `.claude/handoff.local.md`. Commit per step.

## Safety rails (unchanged)
Offline-first (the simulated adapter sends nothing real; a real provider sending real texts stays the
human crossing). One safety model. Don't touch `ops/` or `CLAUDE.md`. Push only to origin. The metered
send is the SAME firewall as Phase 18 (bill from our own record, not the provider). No-oracle keystone
reused from Phase 27 (shared frozen miss, scope-before-effect).
