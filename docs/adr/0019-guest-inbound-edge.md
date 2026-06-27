# ADR 0019 — The guest inbound edge: a guest texts in, the AI replies (metered)

- **Status:** accepted
- **Date:** 2026-06-26
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-26-phase-19-guest-inbound-edge.md`)
- **Scope:** Phase 19 — rung +1 of the human-set guest-facing messaging channel
  ([[guest-messaging-channel-is-a-roadmap-goal]]). It builds the **inbound HTTP edge**: a provider webhook
  delivers a guest's text, the platform resolves the guest, a deterministic offline responder answers from the
  guest's bound wedding, and the reply goes out through `MessagingService.send` — **the first time the
  Phase-18 meter fires from a real request**. It is the **product-channel** half of the goal's gap (guests
  become a real, untrusted actor on the surface). It **defers** the inward North-Star `money_cost` denominator
  (rung +2) and the planner-facing guest-management CRUD (guests are seeded this rung).
- **Builds on** ADR 0018 (the provider boundary + the meter), 0015 (the operator credential tier + the
  ledger), 0013 (the request pipeline + intra-tenant auth), and 0012 (tenant isolation). It adds **no parallel
  safety model**: the guest edge reuses the trusted-evidence firewall (provider = untrusted; our send record =
  the billing basis), the no-existence-oracle disclosure mask, and tenant isolation by construction.

## Context

ADR 0018 left the `MessagingPort.inbound` operation declared but unconsumed over the wire, and the meter had
never been triggered by a request. The roadmap's named capability is that a guest texts the AI and gets an
answer — so this rung wires the inbound edge end-to-end. A guest is a genuinely NEW, UNTRUSTED actor: the
inbound text is attacker-controlled (prompt-injection, existence-oracle probing), and the provider that posts
the webhook is a semi-trusted external system. Both adversarial reviews (architect + doddy, run on the design
AND the built code; the named specialists are not provisioned, so the lenses ran via `general-purpose` agents)
shaped the decisions below; both reached **APPROVE-WITH-CHANGES**, and every must-fix is applied.

## Decisions

1. **A guest is an UNTRUSTED actor bound to ONE wedding by a per-tenant registry — NOT a session Principal.**
   Guests never log in (a `Principal` is minted only by `SessionStore` login), so adding `'guest'` to
   `PrincipalRole` would be dead code or a forged-mint surface. Instead `GuestRegistry` binds an opaque
   `recipient_ref` → `{ wedding_id, guest_id }`, keyed on the `from_ref` ALONE. This binding is the guest
   analogue of the couple's structural ownership and the **sole segmentation gate**: the reply path answers
   only from the bound wedding (the COMMS.MIS_SEGMENTATION analogue). The registry composes
   `TenantScopedRepository`, so tenant isolation (minted-context brand + liveness, partition keyed by
   `tenant_id` alone, byte-identical-undefined for a foreign/unknown ref, cross-tenant-write veto, `#`-private)
   is **inherited, not re-implemented**.

2. **A fourth trust tier — the provider-webhook credential.** The inbound webhook is server-to-server from the
   (simulated) provider, not a browser and not a session, so it is authenticated by a **platform-level
   shared-secret bearer** (`ProviderWebhookCredentialStore`, a verbatim mirror of the Operator tier: phantom
   `WeakSet` brand + sole-mint store + bare `Map.get` resolve with no shape gate — a fourth token namespace
   that never crosses session/operator). The handoff's loose "CSRF" is corrected: a server-to-server webhook's
   anti-forgery guard is a shared secret, not a browser CSRF cookie (browser-form CSRF for the planner
   mutation surface stays a deferred rung). Platform-level (not per-tenant) is right: there is one provider
   integration; the tenant is established by the route `:slug` + the registry, never the credential.

3. **A 17th schema, `inbound_webhook`.** Phase 18 recorded the exact revisit trigger ("inbound accepted over
   HTTP / a stable external wire shape"); this rung fires it. The schema validates the provider WIRE shape
   (`channel`/`from_ref`/`text`/`provider_message_ref`, `additionalProperties:false`, `minLength` guards), not
   the normalized `InboundMessage`. Its `channel` enum is drift-guarded exhaustively against the canonical
   `Channel` (no fourth uncoordinated copy). The port's `RawInboundPayload` is now a TYPE ALIAS of the
   generated `InboundWebhook`, so the wire shape has ONE declaration and a schema field change flows to the
   port at compile time.

4. **The route folds into the one pipeline:** `POST /t/:slug/messaging/inbound`. Tenant-resolve (404 for
   non-active — the established, already-public disclosure for every tenant route) runs first; then
   **webhook-auth is the literal first statement** of the messaging branch (before any method/shape/body
   check, like `/admin`), so route shape is not a pre-auth oracle; the route **skips stages 3–4** (a webhook is
   not a session Principal). Body validation runs AFTER auth, so a malformed body is an honest 400 to the
   trusted provider, never a pre-auth oracle.

5. **The reply path bills from OUR record, and the response discloses nothing.** `handleInbound` does:
   validate → `port.inbound` normalize → **idempotent receive** → segment (registry) → scoped wedding load
   (context + `wedding_id`, two gates) → deny-by-classification responder → metered `send`. **Every
   post-validation branch returns ONE frozen `RESP_ACCEPTED` (202)** — registered or not, answered / escalated
   / deduped — so the response never discloses registry state (doddy P1). Identity comes only from trusted
   state (the registry's stored `recipient_ref` + the bound `wedding_id`), never a body field.

6. **The reply-cardinality firewall (doddy P0 + P1).** A `provider_message_ref` is untrusted and
   provider-controlled. `InboundReceiptLog` (per-tenant, `#`-private, composing `TenantScopedRepository`)
   records refs **already successfully replied to**; the edge replies only to a ref that is not yet `seen`, so
   a re-delivered ref is a no-op (no second reply, no second charge). The reply send's idempotency key is a
   **separately platform-minted id** (`mintReplyId`), never the provider ref. A ref is marked replied ONLY
   AFTER its send succeeds (**commit-after-success**): a send failure is a dropped reply that stays retryable,
   the edge swallows the send's structured error and still returns the uniform 202, so a (today-unreachable)
   margin/cost failure can never become a 500 oracle or a permanently suppressed message. A genuinely fresh
   ref for the same logical message is a genuinely distinct message (the provider's trust level — a documented
   residual).

7. **A product-side deterministic responder, deny-by-fact-classification (doddy P2).** `GuestQaResponder` is
   a small swap seam; `DeterministicGuestQaResponder` answers ONLY from `projectGuestVisibleFacts` — an
   EXPLICIT allow-list projection (no spread), so internal/lifecycle fields and any future surprise-flagged
   fact are structurally unreachable. The untrusted `text` only SELECTS among the safe set; it never gates
   what is readable. It imports NO loop/eval code (the firewall holds by reachability — the product graph
   stays acyclic). This rung's projection is trivial (the wedding aggregate is 3 fields): answer the
   `event_date` on a timing query, escalate everything else; the richer logistics fact model is deferred.

## Consequences

- **The meter finally fires from the request pipeline.** A registered, answerable guest inbound records exactly
  one `usage_charge`; the compose demo seeds one guest so this is demoable end-to-end through the wired surface.
- **No new safety model.** The guest edge is a new surface for existing concerns: the segmentation gate, the
  no-oracle mask, the trusted-record billing firewall, and tenant isolation are all reused/inherited.
- **Boot policy generalized.** The operator-token policy became one `resolveCredentialToken` helper governing
  both the operator and the new `WP_PROVIDER_WEBHOOK_TOKEN` (env-floor / demo-generate-and-print-once /
  non-demo fail-closed), so the two credentials cannot drift.
- **Residuals (accepted, documented):** reply-vs-silence (a registered, answerable ref gets a text; others
  don't — inherent to a messaging channel, discloses only "registered to some wedding on this active tenant",
  to a party already controlling that recipient) and request timing (no constant-time discipline exists offline)
  — both flagged for going-live hardening. A real provider sending real texts remains the human-reserved crossing.
- **Deferred:** the inward North-Star `money_cost` denominator (rung +2); planner-facing guest-management CRUD
  + browser-form CSRF; a richer wedding-facts model; period-batched usage billing; `deliveryStatus` consumption.

## Alternatives considered

- **`guest` as a third `PrincipalRole`.** Rejected — guests never authenticate; it would be dead code or a
  forged-mint surface. The registry binding gives couple-equivalent structural ownership without a session.
- **Per-tenant webhook secret.** Rejected — implies per-tenant provider accounts, a carrier concept that would
  leak into the domain (a lock-in smell). One platform secret + slug-routing + registry-binding is the clean
  three-layer resolution.
- **Idempotency keyed on `provider_message_ref` directly.** Rejected (doddy P0) — hands reply cardinality to
  the untrusted provider. The per-tenant `seen` gate + a platform-minted send key closes it.
- **No 17th schema (keep inbound in-process like the meter).** Rejected — inbound is now a stable EXTERNAL wire
  shape over HTTP, the exact revisit trigger Phase 18 recorded.

related: [[guest-messaging-inbound-edge]], [[guest-messaging-port-and-meter]],
[[guest-messaging-channel-is-a-roadmap-goal]], [[http-edge-and-intra-tenant-auth]],
[[multi-tenant-isolation-boundary]], [[onboarding-billing-operator-tier]].
