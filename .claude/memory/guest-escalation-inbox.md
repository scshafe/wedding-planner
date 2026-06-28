# Guest-escalation inbox (Phase 26)

**What:** When a guest texts an UNANSWERABLE question, the responder returns `escalated` and it is now RECORDED in
a per-tenant, wedding-scoped `EscalationLog`; the couple (their wedding) + planner (whole tenant) READ it via JSON
`GET /t/:slug/escalations` + a themed `?view=escalations` page. Closes the guest→couple loop (gap surfaced → couple
fills the field via the Phase-23 edit form → next ask is answered). Read-only this phase.

**The load-bearing invariants (carry forward):**

- **Record `escalated` ONLY — NEVER `refused`.** The capture predicate is exactly `outcome.action === 'escalated'`.
  `refused` is the fact-independent surprise outcome (frozen `REFUSED`, reads no wedding data); recording it would
  persist surprise-probe content. SAFE to omit because the guest's wire is unchanged (escalated/refused both →
  uniform 202; the record is server-side, couple/planner-only), so "a refused probe never appears in my inbox" is
  observable to no one who could exploit it. COMMS.SURPRISE_LEAK intact. `answered` records nothing either.

- **`text` is UNTRUSTED guest input** — stored for the trusted couple, HTML-escaped at render via the `html`
  SafeHtml template, NEVER reflected to the guest (the responder's F3 forbids guest-facing echo; couple-facing
  storage is different). JSON returns it as an inert string. Render the inbox page through `renderEscalations`
  (no raw bypass). The 19th schema `guest_escalation.text` is byte-identical to `inbound_webhook.text`
  (`minLength:1`, NO maxLength) so a message that passed the inbound edge can NEVER fail `record()`'s `assertValid`
  → no 500 oracle. The capture is therefore NOT swallowed to 202 (a throw is a genuine bug).

- **Idempotency by `provider_message_ref` — the receipt-log pattern reused, NOT the receipt log widened.**
  `EscalationLog` keys its OWN `TenantScopedRepository` by `provider_message_ref` (the same pattern
  `inbound_receipt_log.ts:51` uses); `record()` is read-first-put-if-absent so a re-delivery records exactly one
  (stable `escalation_id`). The receipt log stays the pristine doddy-P0 "refs we charged a reply for" store — do
  NOT mark it for escalations. The two logs dedup DIFFERENT side effects (a charged reply vs a recorded escalation).

- **Couple read scope reuses `GuestAuthorizer.manageScope`** (no new authorizer): planner all / couple their
  wedding via `listForWedding` (partition filter, `undefined → []`), `wedding_id` from the MINTED principal never
  the body. Read deps bag is MINIMAL `{ escalations, authorizer }` (no `weddings`). GET-only; non-GET → 405; auth
  before method (no pre-auth oracle); unknown tenant → masked 404.

- **The web page DELEGATES through the JSON read** (`api.handle(bearerGet('/t/:slug/escalations'))`) — it holds NO
  `escalations` dep, preserving the `@canonical product_web_ui` "only DATA path is `api.handle()`" invariant.
  `?view=escalations` is a read-only page (no CSRF, mirrors the strategy page); every non-200 masks via
  `#renderNonData`.

- **Wiring:** ONE `EscalationLog` instance, wired into BOTH `messaging.escalations` (capture) AND
  `escalations` read deps in `composeProductSurface`; exposed on `ComposedSurface`. `escalations?` on
  `ProductApiDeps` is optional like `messaging` (mounted when wired).

**Deferred (with pinned shapes):** resolution/dismissal = a SEPARATE append-only record keyed by `escalation_id`
(preserving the escalation's immutability), NOT a mutation of `guest_escalation`. Also: routing `refused` to the
couple (the honest "decline vs route-to-couple" divergence), reply-from-the-inbox (console-initiated metered send),
a `topic` field (would widen `GuestQaOutcome`).

doddy + architect APPROVE-WITH-FIXES on the design (no exploit found); all fixes applied. ADR 0026. 820 tests.
Part of [[guest-messaging-channel-is-a-roadmap-goal]]; builds on [[guest-messaging-inbound-edge]],
[[richer-guest-visible-facts]], [[couple-scoped-guest-management]].
