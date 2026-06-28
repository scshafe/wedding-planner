# Phase 26 — Guest-escalation inbox (give `escalated` a real downstream surface)

## Goal
Today, when a guest texts a question the platform **cannot** answer — a logistics question whose fact
is unset (`venue`/`parking`/`dress_code` absent) or an `unknown` topic — the responder returns
`escalated`, the inbound edge sends nothing, and the message **vanishes**: `escalated` (and `refused`)
produce the uniform 202 and leave **no product-side record**. The couple/planner never learn that a
guest asked something the AI could not answer. That is a dead end in the guest-messaging channel.

This rung closes the guest→couple loop: a guest's `escalated` question is **recorded** in a per-tenant,
**wedding-scoped escalation log**, and the couple (their wedding) and the planner (whole tenant) can
**read** their escalations — JSON `GET /t/:slug/escalations` and a themed `?view=escalations` page. The
product loop becomes: *guest asks "what's the parking?" with no `parking_info` set → escalated → couple
sees it in their inbox → couple fills `parking_info` via the Phase-23 edit form → the same question
(fresh provider ref) now `answered` (meter +1)*. The escalation inbox is the missing feedback signal
that tells the couple **which field to fill**.

**Read-only this phase.** Recording + the two read surfaces. Resolution/dismissal of an escalation, a
"reply-from-the-inbox" action, and routing `refused` are documented deferrals (the honest "decline vs
route-to-couple" divergence the responder header already names).

## The load-bearing design decisions (settle in Step 0, carry forward)

- **Record `escalated` ONLY — NEVER `refused` (the no-oracle keystone).** `refused` is the surprise/secret
  outcome, **fact-independent by construction** (reads zero wedding data, returns the frozen `REFUSED`
  constant). Recording a refused probe would (a) persist guest surprise-probe content into a store for
  exactly the topic the system is designed never to engage, and (b) give the couple nothing to *act on*
  (there is no field to fill). Crucially it is **safe to omit**: the guest still gets the uniform 202 for
  both `escalated` and `refused` (wire-unchanged), and the escalation record is visible ONLY to the
  already-authorized couple/planner — so "a refused probe never appears in my inbox" is not an oracle for
  anyone (the couple already owns all their wedding data; the guest sees nothing). The capture predicate is
  exactly `outcome.action === 'escalated'`. `answered` sends a reply (unchanged); `refused` stays
  silent-and-unrecorded. Routing `refused` to the couple is a separate, larger design (deferred).

- **`text` is UNTRUSTED guest input — stored for the couple, HTML-escaped at render, never reflected to the
  guest.** The responder's doddy-F3 rule (a reply never echoes the inbound `text` back to the *guest*) is
  about guest-facing reflection; storing the question for the *trusted couple* to read is different and is
  the whole point. The couple-facing HTML render MUST pass `text` through the existing `html` SafeHtml
  template (Phase-14 escaping); the JSON API returns it as a JSON string value (inert). A test asserts an
  XSS payload in `text` is escaped in the rendered page.

- **`guest_escalation.text` must be NO STRICTER than `inbound_webhook.text` (no 500-oracle).** `inbound_webhook
  .text` is `minLength:1`, **no maxLength**. If the escalation schema added a maxLength, a long text that
  *passed* the inbound edge would *fail* `EscalationLog.record`'s `assertValid` → an unexpected 500 (a crash
  on a legit message AND a length oracle). So `guest_escalation.text` = `minLength:1`, **no maxLength** —
  byte-identical constraint. Every field `record()` writes is sourced from values already validated upstream
  (`from_ref`/`text`/`provider_message_ref` by `inbound_webhook`; `wedding_id` from the trusted binding;
  `received_at` port-stamped), so `record()` cannot be made to throw by guest input.

- **Idempotency by `provider_message_ref` — the receipt-log pattern reused, NOT the receipt log widened.**
  Today an `escalated` ref is never marked in `InboundReceiptLog` (only `answered` refs are, after a
  successful send), so a re-delivery re-runs the responder harmlessly (no side effect). Adding the escalation
  **write** introduces a side effect that a re-delivery would duplicate. Rather than widen the doddy-P0
  receipt log's narrow "refs we charged a reply for" invariant (and bolt a meaningless `reply_id` onto an
  escalation), the **`EscalationLog` keyes its own `TenantScopedRepository` by `provider_message_ref`** — the
  *exact same* `provider_message_ref`-as-dedup-key-within-the-tenant-partition pattern the receipt log itself
  uses (`inbound_receipt_log.ts:51`). `record()` is **read-first-then-put-if-absent**: a re-delivered ref
  returns the existing record (stable `escalation_id`, no duplicate). One pattern applied twice (each dedups a
  *different* side effect — a charged reply vs a recorded escalation), not a second mechanism. The receipt log
  stays pristine.

- **Couple scope is the EXISTING `GuestAuthorizer.manageScope` — no new authorizer, no new scope type.** The
  escalation inbox scopes exactly like the guest list: planner `{kind:'all'}` → `escalations.list(context)`;
  couple `{kind:'wedding', wedding_id}` → `escalations.listForWedding(context, wedding_id)` (a partition
  filter, oracle-free, mirroring `guest_registry.listForWedding`, including the `undefined → []` collapse).
  `wedding_id` comes from the minted principal, never the body. Read-only: GET → scoped list; any other
  method → 405 (route is tenant-independent; 405 is not a tenant oracle). Sits in the authenticated pipeline
  (auth before method) so an unknown tenant is the same masked 404; never a pre-auth oracle.

- **`from_ref` disclosure is already-permitted.** The couple already sees `recipient_ref`s via their Phase-24
  guest list; the escalation's `from_ref` (the opaque sender handle) discloses nothing new to the couple.

## The escalation record (19th schema: `guest_escalation`)
`product/schemas/guest_escalation_schema.json`, `additionalProperties:false`, all required:
- `escalation_id` — platform-minted (`ids.next('escalation')`), the public surrogate id. `minLength:1`.
- `tenant_id` — partition stamp (COMPARE-only, like `Guest`). `minLength:1`.
- `wedding_id` — the bound wedding; the couple-scope key. `minLength:1`.
- `from_ref` — opaque guest sender handle (the inbound `from_ref`). `minLength:1`.
- `text` — the guest's question. `minLength:1`, **no maxLength** (matches `inbound_webhook.text`).
- `received_at` — the message's port-stamped timestamp (ISO 8601; mirror `wedding.created_at`/`billing_event
  .occurred_at` format conventions — confirm in Step 1).
- `provider_message_ref` — opaque inbound message id; the **storage/idempotency key**. `minLength:1`.

## Steps

- [x] **Step 0 — Design review.** doddy + rigorous-architect (general-purpose lenses) both **APPROVE-WITH-FIXES**;
  **no constructible exploit found.** Confirmed PASS: (1) `escalated`-only (never `refused`) is wire-unchanged
  (both fall through the same frozen `RESP_ACCEPTED`; record is server-side, couple/planner-only) → no
  surprise/existence oracle, COMMS.SURPRISE_LEAK intact; (2) `text` escaping via the `html` SafeHtml template is
  sufficient (escapes all 5 metachars, text+attr contexts; JSON value is inert; no guest reflection path); (3)
  `guest_escalation.text`=`minLength:1`/no-maxLength matching `inbound_webhook.text` is correct — verified
  field-by-field (`from_ref`/`provider_message_ref` also match `minLength:1`; `received_at` is port-stamped not
  guest-controlled; `wedding_id`/`tenant_id`/`escalation_id` trusted) so `record()` cannot be provoked to throw →
  no 500 oracle; (4) idempotency-by-`provider_message_ref` in a self-contained `EscalationLog` (receipt log
  pristine) is the right call — "one pattern applied twice" (the two logs dedup DIFFERENT side effects on
  DIFFERENT commit timing; widening the doddy-P0 receipt log would two-mean its store + bolt a meaningless
  `reply_id`); (5) reusing `manageScope` is sound (scope logic is identical; a dedicated read authorizer would
  duplicate it); (6) no pre-auth/cross-wedding/cross-tenant oracle (auth-before-method, partition filter,
  masked-404). **Fixes folded in below:** **(F1, load-bearing — both lenses)** Step 4's `#escalationsPage` must
  read via `this.#api.handle(bearerGet('/t/:slug/escalations', token))` and mask every non-200 via the existing
  non-data renderer — mirror `#guestsPage` LITERALLY; **NO `escalations` dep on the web UI** (its `@canonical`
  invariant is "only DATA path is `api.handle()`"; deps stay `{api,themes,csrf}`). Add a tolerant `readEscalations`
  body reader (like `readGuests`) + handle `?view=escalations` in `#console`. **(F2, doddy)** make the
  `received_at` format confirmation a HARD gate in Step 1 and unit-test `record()` against the REAL port-stamped
  value (not a hand-written literal) so a format mismatch can't become a latent per-escalation 500. **(F3,
  architect)** the read deps bag is MINIMAL `{ escalations, authorizer }` — it does NOT carry `weddings` (unlike
  `GuestHandlerDeps`, which needs it for register referential integrity). **(F4, architect)** add a one-line doc
  note on the `manageScope` reuse (escalation-visibility scope == guest-management scope = the wedding partition);
  do NOT rename (would touch Phase-24 call sites for no behavioral gain). **(F5, bookkeeping)** also fix the
  `schema_registry.test.ts:12` title prose ("exactly the 18 canonical contracts"→19) and cite the exact gen-script
  string at `generate_contract_types.ts:2`; the on-disk drift-guard (`discoveredSet.size===CONTRACT_COUNT`) passes
  automatically once file+manifest both land at 19. **(F6, architect)** pin the future-resolution shape in the ADR
  (decided: a SEPARATE append-only resolution record keyed by `escalation_id`, preserving the escalation record's
  immutability — NOT a mutation of `guest_escalation`).

- [x] **Step 1 — The contract (19th schema) + the log.** Add `product/schemas/guest_escalation_schema.json`
  (shape above). **F2: confirm the `received_at` format against the REAL port-stamped value** — check what the
  simulated adapter's `clock.now()` emits and what existing timestamp schemas (`wedding.created_at`,
  `billing_event.occurred_at`) declare; if the schema adds a `format`/`pattern` it MUST accept that exact value,
  and the `EscalationLog` unit test must call `record()` with the real port-stamped `received_at` (not a literal)
  so a mismatch fails loudly here, never as a latent per-escalation 500. Register it: add `guest_escalation` to
  the `ContractKey` union + a `CONTRACT_DEFINITIONS` entry in `shared/src/contracts/contract_manifest.ts`, bump
  its header comment "18"→"19" (`CONTRACT_COUNT` is derived — no numeric edit); update
  `shared/tests/contracts/schema_registry.test.ts` (`toBe(18)`/`toHaveLength(18)` → 19 **and the title prose at
  line 12 "exactly the 18 canonical contracts"→19**; the on-disk drift-guard `discoveredSet.size===CONTRACT_COUNT`
  passes automatically once file+manifest both land at 19) and the `generate_contract_types.ts:2` header string
  "Generate TypeScript types from the 18 JSON Schema contracts."→"19"; run `npm run gen:types`. Add
  `product/src/messaging/escalation_log.ts` — `EscalationLog` over `TenantScopedRepository<GuestEscalation>`
  **keyed by `provider_message_ref`**, constructor `(liveness, ids)`. Methods: `record(context, { wedding_id,
  from_ref, text, received_at, provider_message_ref })` (read-first; if present return existing; else mint
  `escalation_id`, assemble with `tenant_id` from context, `assertValid('guest_escalation', …)`, `put`,
  return); `list(context)` (planner: this tenant's partition); `listForWedding(context, wedding_id)` (couple:
  partition filter on `wedding_id`; `undefined → []`). Canonical doc comment covering the four design
  decisions. Unit tests `product/tests/messaging/escalation_log.test.ts`: record mints+validates+puts;
  re-delivery (same `provider_message_ref`) is idempotent (same `escalation_id`, one record); `list` vs
  `listForWedding` scoping incl. `undefined → []`; tenant isolation (foreign context can't read); liveness
  (suspended tenant throws on every method). `npm run build && npm test && npm run lint` green.

- [x] **Step 2 — Capture at the inbound edge (`product_api.ts`).** Add `escalations: EscalationLog` to
  `MessagingHandlerDeps`. In `handleInbound`, after the responder call, on `outcome.action === 'escalated'`
  call `deps.escalations.record(context, { wedding_id: binding.wedding_id, from_ref: message.sender_ref,
  text: message.body, received_at: message.received_at, provider_message_ref: message.provider_message_ref })`
  — sourced from trusted state/already-validated message fields ONLY, never the raw body. NOT wrapped in the
  send's swallow-to-202 try/catch (a `record()` throw would be a genuine bug → honest 500; it cannot be
  provoked by valid guest input — see the no-500-oracle decision). `answered` keeps its exact send +
  `markReplied` path; `refused` falls through to the unchanged `RESP_ACCEPTED`. Update the `handleInbound`
  docstring (step 4 now: answer→send, escalate→record, refuse→nothing; all still uniform 202). Tests in
  `product/tests/http/`: escalated → exactly one record with the right field provenance; answered → zero
  records; refused → zero records; re-delivery of an escalated ref → still one record; a body-smuggled
  `wedding_id`/`from_ref` is inert (record uses binding/message, not body). Green.

- [x] **Step 3 — JSON read surface (`product_api.ts`).** Add `GET /t/:slug/escalations` via a new
  `dispatchEscalations` paralleling `dispatchGuests`, reached **only after `#authenticate`** (auth-before-method,
  so an unknown slug masks identically + method≠GET is a tenant-independent 405, not an oracle): GET →
  `handleEscalationList(context, principal, deps)` branching on `manageScope(principal)` (all →
  `escalations.list`; wedding → `escalations.listForWedding`); any other method → 405. Reuses
  `GuestAuthorizer.manageScope` (no new authorizer; F4 doc-note on the read reuse). **F3: the read deps bag is
  MINIMAL `{ escalations, authorizer }`** — it does NOT carry `weddings` (no referential-integrity read here).
  Wire `escalations` into the JSON deps bag + the composition root (`composeProductSurface`) + `ComposedSurface`
  (mirror `messaging`/`registry`). Tests in
  `product/tests/http/`: planner sees all tenant escalations; couple sees ONLY their wedding's (a sibling
  wedding's escalation never appears); a couple of wedding B cannot see wedding A's; method ≠ GET → 405;
  unauth → 401; cross-tenant isolation (tenant Z's GET never sees tenant Y's). Green.

- [x] **Step 4 — Themed `?view=escalations` page + e2e + docs.** Add `#escalationsPage` to `product_web_ui.ts`
  **mirroring `#guestsPage` LITERALLY (F1, load-bearing):** read via `this.#api.handle(bearerGet('/t/:slug/
  escalations', token))`, render ONLY on `status===200`, and mask every non-200 with the existing non-data
  renderer (`#renderNonData`/equivalent) so unknown-slug/forbidden/suspended all mask identically. **NO
  `escalations` dep on the web UI** — its deps stay `{api,themes,csrf}` (the `@canonical` "only DATA path is
  `api.handle()`" invariant). Add a tolerant `readEscalations` body reader (like `readGuests`) + a
  `?view=escalations` branch in `#console`. Render a themed list (each row: `from_ref`, the **HTML-escaped**
  question `text` via the `html` template, `received_at`) with a note linking the couple to the edit form ("a
  guest asked this and we couldn't answer — set the matching field"). Tests `product/tests/web/`: planner +
  couple render their scoped inbox;
  an **XSS payload** in a stored `text` is HTML-escaped in the page (the security assertion); unknown slug →
  masked 404. A compose-level **e2e** (`compose.test.ts`): a guest texts "where do I park?" with no
  `parking_info` → escalated (meter 0) → the couple's `?view=escalations` (or JSON GET) shows the question →
  the couple sets `parking_info` via the edit form → the **same** question with a FRESH `provider_message_ref`
  now `answered` (meter 1). Write **ADR 0026**, memory `guest-escalation-inbox.md` (+ index in `MEMORY.md`),
  update `.claude/handoff.local.md`. Final `npm run build && npm test && npm run lint` green; commit per step.

## Out of scope (deferred, with reason)
- **Routing `refused` to the couple** — the honest "decline vs route-to-couple" divergence; recording a
  surprise probe is a delicate content/oracle decision of its own (this phase deliberately records `escalated`
  only). Its own rung.
- **Escalation resolution / dismissal** — marking an escalation handled (e.g., once the couple fills the field,
  or a manual dismiss). The inbox is an append-only log this phase; a re-delivery that now `answers` leaves the
  historical escalation in place (accurate: it WAS unanswerable at the time). **Intended shape (pinned in the
  ADR, F6):** a SEPARATE append-only resolution record keyed by `escalation_id` — preserving the escalation
  record's immutability — NOT a mutation of `guest_escalation`. Needs a mutation surface + its own CSRF/oracle pass.
- **Reply-from-the-inbox** — letting the couple/planner answer an escalated guest directly (a metered send
  initiated from the product UI). A new outbound-from-console capability; larger.
- **A `topic` field on the record** — would require widening `GuestQaOutcome` to surface the classified topic;
  the stored question text already conveys the ask. Nice-to-have, deferred.
