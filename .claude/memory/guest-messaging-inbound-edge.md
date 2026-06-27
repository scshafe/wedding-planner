---
name: guest-messaging-inbound-edge
description: "Phase 19: the guest inbound HTTP edge — a guest texts in via a provider webhook, a deterministic product-side responder answers from the guest's bound wedding, and the reply goes out through MessagingService.send (the first time the Phase-18 meter fires from a request). A guest is an UNTRUSTED actor bound to ONE wedding by a per-tenant registry (NOT a session Principal); a 4th provider-webhook trust tier; a 17th schema; uniform-202; the reply-cardinality firewall."
metadata:
  node_type: memory
  type: project
---

**Phase 19 (rung +1 of [[guest-messaging-channel-is-a-roadmap-goal]]).** Wired the **guest inbound HTTP edge**
on top of the Phase-18 boundary+meter ([[guest-messaging-port-and-meter]]): `POST /t/:slug/messaging/inbound`
(a provider webhook) → resolve the guest → a product-side deterministic responder answers from the guest's
**bound wedding** → the reply goes out through `MessagingService.send` — **the FIRST time the meter fires from
a real request**. End-to-end, offline, demoable (compose seeds one demo guest). ADR 0019. 695 tests (from 651).
Both adversarial reviews (architect + doddy, design AND built code) APPROVE; every must-fix applied.

**The load-bearing decisions / invariants (carry forward):**

- **A guest is an UNTRUSTED actor bound to ONE wedding by a per-tenant `GuestRegistry`, NOT a session
  Principal.** Guests never log in (a Principal is minted only by `SessionStore`), so `'guest'` was NOT added
  to `PrincipalRole` (it would be dead code / a forged-mint surface). `GuestRegistry` binds `recipient_ref →
  {wedding_id, guest_id}` keyed on the `from_ref` ALONE — the guest analogue of the couple's structural
  ownership and **the sole segmentation gate** (COMMS.MIS_SEGMENTATION analogue). It COMPOSES
  `TenantScopedRepository`, so isolation is INHERITED not re-implemented (minted-context brand+liveness,
  partition keyed by `tenant_id` alone, foreign/unknown ref → byte-identical `undefined`, cross-tenant-write
  veto, `#`-private). `InboundReceiptLog` composes it the same way.

- **The 4th trust tier: `ProviderWebhookCredentialStore`** (`product/src/auth/provider_webhook_credential.ts`)
  — a verbatim mirror of the Operator tier (phantom WeakSet brand + sole-mint store + bare `Map.get` resolve,
  NO shape gate). A platform-level shared secret (one provider integration; the tenant comes from the `:slug` +
  registry, never the credential). The webhook is server-to-server, so its guard is a **shared secret, not a
  browser CSRF cookie** — the handoff's "CSRF" was loose; browser-form CSRF (planner mutations) stays deferred.
  Token namespaces session/operator/provider-webhook never cross (a foreign token → identical constant 401).

- **The route precedence:** tenant-resolve (404 non-active — already-public disclosure for ALL tenant routes)
  → **webhook-auth is the literal first statement** of the messaging branch (before any method/shape/body
  check, like `/admin`) so route shape is not a pre-auth oracle → the route **SKIPS stages 3–4** (a webhook is
  not a session Principal — it's the 3rd route to skip them, after login + `/healthz`). Body validation runs
  AFTER auth → a malformed body is an honest 400 to the trusted provider (not masked), not a pre-auth oracle.

- **Uniform 202 (doddy P1):** ONE frozen `RESP_ACCEPTED` returned on EVERY post-validation branch
  (unregistered / escalated / answered / replay / cross-tenant) so the response never discloses registry state.
  Pinned byte-identical by the keystone. Residuals (accepted, documented, flagged for going-live): reply-vs-
  silence (answering a registered guest is inherent; discloses only "registered to some wedding on this active
  tenant", to a party already controlling that recipient) + request timing (no constant-time offline).

- **The reply-cardinality firewall (doddy P0 + P1) — `InboundReceiptLog`.** A `provider_message_ref` is
  UNTRUSTED + provider-controlled. The log records refs **already successfully replied to**, per tenant; the
  edge replies only to a ref not yet `seen` (re-delivery = no-op, no second charge). The send idempotency key
  is a **separately platform-minted id** (`mintReplyId`), NEVER the provider ref. **Commit-after-success**: a
  ref is marked replied ONLY AFTER its send succeeds, and `handleInbound` swallows the send's structured
  `WeddingPlannerError` and still returns 202 — so a (today-unreachable, the price-book margin always clears)
  send failure can never become a 500 oracle or a permanently SUPPRESSED message; it stays retryable. A
  genuinely fresh ref for the same logical message IS a distinct message (the provider's trust level — a
  documented residual). **`handleInbound` order is load-bearing:** validate → normalize → `seen` (before any
  read) → segment → scoped wedding load (context + wedding_id, TWO gates, no id-alone key) → responder →
  send → markReplied.

- **Deny-by-fact-classification (doddy P2) — the responder.** `DeterministicGuestQaResponder` answers ONLY
  from `projectGuestVisibleFacts` — an EXPLICIT allow-list projection (NO spread), so internal/lifecycle +
  future surprise-flagged fields are structurally unreachable. The untrusted `text` only SELECTS among the
  safe set; it never gates readability. Imports NO loop/eval (firewall by reachability; product graph acyclic).
  `GuestQaResponder` is a swap seam; the impl is trivial this rung (3-field wedding → answer `event_date` on a
  timing query, else escalate). `'refused'` is in the vocabulary for future surprise-classified facts but
  unemitted now (documented forward-compat).

- **The 17th schema `inbound_webhook`** validates the provider WIRE shape (not the normalized `InboundMessage`);
  named to avoid clashing with the port's `InboundMessage`. `RawInboundPayload` is now a TYPE ALIAS of the
  generated `InboundWebhook` (ONE declaration; schema change flows to the port at compile time). Its `channel`
  enum is drift-guarded exhaustively against the canonical `Channel`. **Schema change ⇒ `npm run gen:types`**;
  the manifest count moved 16→17 (and the `CONTRACT_DEFINITIONS.length`/registry-discovery tests with it).

- **Wiring:** `MessagingHandlerDeps` (port/receipts/registry/weddings/responder/service) is **OPTIONAL** on
  `ProductApiDeps`, mirroring `championStrategy` — absent ⇒ the `/messaging` route is not mounted (masked 404);
  `composeProductSurface` always wires it; tests that exercise the edge inject it, others omit it. The
  operator-token policy generalized to ONE `resolveCredentialToken` helper governing both the operator and the
  new `WP_PROVIDER_WEBHOOK_TOKEN` (env-floor / demo-generate-print-once / non-demo fail-closed).

**Deferred (the next levers):** the inward North-Star **`money_cost` denominator** (rung +2 — make per-message
cost trade against the objective so cadence/spacing/batching trade real money; mirror the Phase 6–10
trusted-reconciliation pattern); **planner-facing guest-management CRUD + browser-form CSRF** (the first
planner mutation trust surface); a **richer wedding-facts model** (ceremony time/venue/parking/dress code) so
the responder answers real logistics; **period-batched usage billing**; `deliveryStatus` consumption. A real
provider sending real texts stays the **human-reserved crossing** (guest-comms tier-2).
