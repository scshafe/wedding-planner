# Phase 19 — The guest inbound edge: a guest texts in, the AI replies (metered)

**Status:** IN PROGRESS — Step 0 (design reviews) complete; Steps 1–4 pending.
**Branch:** `build/phase-3-generalize-search` (the open review artifact for `main`; Phases 3–18 build on it; this continues it)
**Predecessor:** Phase 18 (the messaging provider boundary + the meter) — complete, 651 tests green.

## Goal

Continue the **guest-facing messaging channel** ([[guest-messaging-channel-is-a-roadmap-goal]]) — rung +1.
Phase 18 built the provider-agnostic `MessagingPort` + the offline adapter + the metered/margin-priced
`MessagingService`, but **wired no HTTP route**: the port declares `inbound`, yet nothing consumes it over
the wire, and the meter has never fired from a real request. This rung builds **the inbound HTTP edge** —
a guest texts in (a provider webhook), the platform resolves the guest, a deterministic offline responder
answers from that guest's bound wedding, and the reply goes out through `MessagingService.send`, **finally
triggering the meter from the request pipeline**. End-to-end, demoable, offline.

It satisfies the **product-channel** half of the roadmap goal's gap: guests become a real (untrusted) actor
on the surface, and the provider boundary gets its receive edge. It deliberately **defers** the inward
**North-Star `money_cost` denominator** wiring (rung +2 — making cadence/spacing/batching trade real money
in the objective) and **planner-facing guest-management CRUD** (guests are seeded this rung).

## The hard rails (unchanged — CLAUDE.md)

Offline-first. **No real provider, no real texts, no real money.** The simulated adapter sends nothing; a
**real provider sending real texts is the human-reserved crossing** (guest-comms tier-2) — build up to the
edge, never across it. The product surface **imports only `@wedding-planner/shared`, never loop/eval** (the
trusted-evidence firewall is preserved by REACHABILITY — the graph stays acyclic): the "AI that answers a
guest" is a **product-side deterministic responder**, NOT the eval persona scorer or any loop code. Injected
clock/ids (no ambient time/RNG). Money is integer cents. One safety model (reuse, never a parallel one).
Don't modify `ops/` or `CLAUDE.md`. Push only to `origin`. **Schema change ⇒ `npm run gen:types`.**

## Step 0 — Design reviews (COMPLETE ✅)

Two adversarial reviews (architect + doddy lenses, via `general-purpose` agents — the named specialists are
not provisioned here). **Both: APPROVE-WITH-CHANGES.** The bones are right; the breaks are all at the new
seam where an **untrusted provider field** (`provider_message_ref`) and an **untrusted sender**
(`from_ref`/`text`) cross into pricing-cardinality and segmentation decisions. The ratified design + the
must-fixes folded into the steps below:

### Ratified design calls
- **The guest is an UNTRUSTED actor, NOT a session `Principal`.** Guests never log in; a `Principal` is
  minted only by `SessionStore` login. Adding `'guest'` to `PrincipalRole` would be dead code or a fake
  mint. Instead a guest is identified by an opaque `recipient_ref` and **bound to exactly ONE wedding via a
  per-tenant guest registry** — the couple-equivalent *structural ownership* (the COMMS.MIS_SEGMENTATION
  analogue). `PrincipalRole` stays `planner|couple`.
- **A new trust tier — the provider webhook credential.** The inbound webhook is server-to-server from the
  (simulated) provider, not a browser and not a session. Authenticate it with a **platform-level
  shared-secret bearer** (`ProviderWebhookCredentialStore`, mirroring `OperatorCredentialStore` exactly —
  phantom brand + module-private `WeakSet` + `#`-private `Map.get` resolve with no shape gate, a SEPARATE
  fourth token namespace). The handoff's "CSRF" is loose — a server-to-server webhook's anti-forgery guard
  is a shared secret, not a browser CSRF cookie; **browser-form CSRF stays deferred.** Platform-level (not
  per-tenant) is correct: there is one platform-wide provider integration; the tenant is established by the
  `:slug` + the registry, not the credential.
- **A 17th schema (`inbound_message_schema.json`) is justified** — Phase 18 recorded the exact revisit
  trigger ("inbound accepted over HTTP / a stable external wire shape"); this rung fires it. It validates the
  **provider wire shape** (`RawInboundPayload`: `channel`/`from_ref`/`text`/`provider_message_ref`), not the
  internal `InboundMessage`. Its `channel` enum gets the **same CI drift-guard** as `channel.ts` (no fourth
  uncoordinated copy).
- **The route:** `POST /t/:slug/messaging/inbound`, folded into the existing `/t/:slug/...` branch. Pipeline:
  resolve tenant (404 non-active — consistent with every tenant route; active-tenant existence is already
  public via theming) → **webhook-auth (401) as the literal first statement of the `messaging` branch,
  before any method/shape/body check** (so route shape isn't a pre-auth oracle, like `/admin`) → it **skips
  stages 3–4** (no session/bind; a webhook is not a Principal) → validate body → normalize → dedupe → resolve
  guest → respond → maybe send.

### Must-fixes folded into the steps (doddy P0/P1/P1 + architect)
- **[doddy P0] Idempotency cardinality is the provider's unless we gate the receive.** Deriving the send
  `idempotency_key` straight from the untrusted `provider_message_ref` lets a provider double-charge (replay
  with a fresh ref) or suppress (reuse a ref). FIX: a **per-tenant `#`-private inbound dedupe receipt log
  keyed on `provider_message_ref`** runs BEFORE any reply is triggered — a re-delivered ref is dropped to the
  uniform 202 (idempotent receive); the send's `idempotency_key` is **platform-minted** (the inbound receipt
  id), never echoed from the wire. The raw `provider_message_ref` is stored opaque/reconciliation-only.
  (Genuinely-distinct refs = genuinely-distinct messages = the provider's trust level; that residual is
  inherent and accepted.)
- **[doddy P1] The 202 must be ONE frozen byte-identical constant** across ALL post-validation branches
  (unregistered ref, bad guest, refused, escalated, answered), so reply-status never discloses registry
  state. A keystone test asserts byte-identity. Document the **reply-vs-silence** and **timing** deltas as
  *bounded, inherent* residuals (you cannot answer registered guests without answering them; no constant-time
  discipline exists anywhere offline) — disclosing only "this ref is registered to some wedding on this
  active tenant," never which wedding or any PII, and only to a party already controlling that recipient.
- **[doddy P1] The registry is the SOLE segmentation gate — make it unforgeable.** Key it on `from_ref`
  ONLY (never a body-smuggled `guest_id`/`wedding_id`); nest it **per-tenant `#`-private under the minted
  `TenantContext`** (partition key = `ctx.tenant_id`, like the meter); the responder reads facts through the
  **tenant-scoped repo with `context` AND filters to the registry-supplied `wedding_id`** (two gates — a
  wedding_id alone is never a key; the global id counter can collide across tenants). Keystone test: a
  `from_ref` registered on tenant B, presented on tenant A's route → uniform 202, no reply, no read of B.
- **[doddy P2] Surprise/PII leak via crafted inbound `text` → deny-by-fact-classification.** The responder
  resolves the bound wedding → loads a **guest-visible fact projection (surprises excluded AT PROJECTION)** →
  matches the opaque `text` against that already-safe set → answer | escalate | refuse. Never load the full
  set and filter; `text` selects among safe answers, never gates what is readable.
- **[architect] Responder impl stays trivial.** The wedding aggregate has only
  `couple_display_name`/`event_date`/`status` — there are no logistics facts yet. So the impl answers
  `event_date` ("when is the wedding") and **escalates everything else**; the `GuestQaResponder` interface is
  a genuine seam (the future fact-model/strategy swap point) but the body is near-trivial this rung. Note the
  facts model expands later.

## The steps (each ends GREEN: `npm run build && npm test && npm run lint`; commit per step)

- [ ] **Step 0 — Design reviews.** (COMPLETE — see above; recorded in this plan.)

- [x] **Step 1 — The provider-webhook trust tier + the inbound route skeleton.** (DONE — 667 tests green;
  the fourth token namespace + the frozen uniform-202 route skeleton + the boot-time credential policy.)
  - New `product/src/auth/provider_webhook_credential.ts` — `ProviderWebhookCredentialStore`, a verbatim
    mirror of `operator_credential.ts` (phantom `WEBHOOK_BRAND`, module-private `MINTED_WEBHOOK_PROVIDERS`
    `WeakSet`, `#byToken` `Map.get` resolve with NO shape gate, constructor-injected seed tokens, dup/empty
    rejected, never re-exported from the barrel). A `ProviderWebhookCredential` carries only a non-secret id.
  - `product_error.ts` — add `PRODUCT.NO_WEBHOOK_CREDENTIAL` (→ constant 401, alongside NO_SESSION/NO_OPERATOR)
    + `PRODUCT.FORGED_WEBHOOK_PROVIDER` / `PRODUCT.DUPLICATE_WEBHOOK_TOKEN` as needed.
  - `product_api.ts` — add a `messaging` branch inside `/t/:slug/...` (AFTER `resolveBySlug`): the FIRST
    statement is `#authenticateWebhook(req)` (bare resolve → 401), then `if segments[2]==='messaging' &&
    segments[3]==='inbound'`, POST-only (405 after auth), returning a **frozen `RESP_ACCEPTED` (202)**
    constant stub (no body consumption yet). Wire `webhookCredentials` into `ProductApiDeps` (lives ONLY in
    the pipeline, like `#operators`). Update the pipeline docstring: `inbound` is the third route that skips
    stages 3–4.
  - `compose.ts` + `ComposeProductSurfaceConfig` — construct `ProviderWebhookCredentialStore` from an
    injected `providerWebhookToken`; pass to `ProductApi`. (app/server.ts wiring + the env floor land with
    the entrypoint, mirroring the operator token — note if deferred to Step 4.)
  - Tests (`product/tests/...` mirroring source): unauth → 401; wrong-namespace token (session/operator) →
    identical 401; authed POST → 202; authed non-POST → 405; the 202 is the frozen shared constant; a webhook
    token is absent in the session/operator namespaces and vice-versa.

- [x] **Step 2 — The 17th schema + body validation.** (DONE — 669 tests green; `inbound_webhook` is the
  17th contract, channel drift-guarded; the inbound edge validates the wire shape → honest 400 post-auth.
  Normalization (`port.inbound`) deferred to Step 4 where its consumer (registry lookup) lives — no dead code.)
  - New `product/schemas/inbound_message_schema.json` — validates `RawInboundPayload`
    (`channel` ∈ canonical enum, non-empty `from_ref`/`text`/`provider_message_ref`, `additionalProperties:
    false`). `npm run gen:types` to regenerate the contract type.
  - A **drift-guard test** pinning the schema's `channel` enum exhaustive against `shared` `Channel` /
    `CHANNELS` (mirror `shared/tests/domain/channel.test.ts`), so this is not a fourth uncoordinated copy.
  - `product_api.ts` — in the inbound handler, parse + validate the body against the schema (honest **400**
    to the trusted provider on bad shape — after auth, so not a pre-auth oracle), then `port.inbound(payload)`
    to normalize to `InboundMessage`. Still returns the uniform 202 (no reply yet). The `MessagingPort` (or
    the service) is threaded to the pipeline for `inbound`/`send` (a narrow messaging dep bag).
  - Tests: schema accepts a valid payload / rejects each missing-or-bad field + a non-enum channel; the
    drift-guard; bad body → 400; valid body → 202; the 400 is the code-free constant.

- [ ] **Step 3 — The guest registry + the responder (pure tested units).**
  - New `product/src/messaging/guest_registry.ts` — `GuestRegistry`: a `#`-private per-tenant partition
    (`tenant_id → Map<from_ref, {wedding_id, guest_id}>`), `lookup(context, from_ref)` taking the **minted
    `TenantContext`** (partition key = `ctx.tenant_id`), `register(context, {recipient_ref, wedding_id,
    guest_id})` for seeding. Unknown ref → `undefined` (no oracle). Never enumerates/serializes.
  - New `product/src/messaging/guest_qa_responder.ts` — `GuestQaResponder` interface
    (`respond(facts, text) → {action: 'answered'|'escalated'|'refused', body?}`) + a trivial deterministic
    impl: builds a **guest-visible fact projection** from the bound wedding (surprises excluded at
    projection — none exist yet, but the structure is deny-by-classification), answers `event_date`,
    escalates all else. No loop import; pure.
  - Tests: registry per-tenant isolation (B's ref invisible on A's partition), `from_ref`-only keying,
    unknown → undefined; responder answers event_date, escalates unknown, and a surprise-classified fact is
    unreachable for EVERY input text.

- [ ] **Step 4 — Integrate: the metered reply path + the oracle keystones + the seed.**
  - `product_api.ts` inbound handler, full path: per-tenant **inbound dedupe receipt** (keyed on
    `provider_message_ref`, `#`-private — first occurrence processes, replay → uniform 202 no-op) → registry
    `lookup(context, from_ref)` → on a binding, load the bound wedding via the scoped repo (`context` +
    `wedding_id`, two gates) → `GuestQaResponder.respond(...)` → on `'answered'`,
    `MessagingService.send(context.tenant_id, outbound)` with a **platform-minted `idempotency_key`** (the
    inbound receipt id) → **return the frozen 202 on every branch**. (The inbound dedupe receipt log lives in
    a small `#`-private store, peer of the registry — or on the messaging service; decide at build, keep it
    per-tenant.)
  - `compose.ts` — wire the registry + responder + receipt log; **seed one demo guest** bound to the demo
    wedding (a placeholder `recipient_ref`) so inbound→reply→meter is demoable end-to-end. app/server.ts +
    `server_config.ts` env floor for `providerWebhookToken` (mirror the operator token: demo ⇒ generate+log
    once, non-demo unset ⇒ fail closed; never bake/echo).
  - Keystone tests (mirror the onboarding byte-identity keystones): end-to-end inbound→reply→one
    `usage_charge` metered; **byte-identical 202** across unregistered / bad-guest / refused / escalated /
    answered; **replay** (same `provider_message_ref`) → no second charge → uniform 202; **cross-tenant** ref
    (registered on B, sent on A) → 202, no reply, no read of B; unregistered ref → 202, no send, no meter
    entry; provider sending a fresh ref for the same logical message DOES re-charge (documented residual).
  - **Final review** (architect + doddy on the BUILT code, via `general-purpose` agents) — apply findings
    before ticking. **ADR 0019.** **Memory** `guest-messaging-inbound-edge.md` (+ index in MEMORY.md). Update
    `.claude/handoff.local.md`.

## Recorded deferrals (carry forward — write into the memory)
- **Inward North-Star `money_cost` denominator (rung +2):** make per-message cost a denominator term so the
  comms strategy trades real money. A substantial inward rung (genome / simulator Stage A&B / a 9th integrity
  effect kind / scoring) — mirror the trusted-reconciliation pattern of Phases 6–10.
- **Planner-facing guest-management CRUD** (register/list/remove guests) — guests are seeded this rung; the
  authenticated planner surface for managing them is a later rung (folds naturally with the deferred HTML
  create/update forms + **browser-form CSRF**, the first planner mutation trust surface).
- **A richer wedding-facts model** (ceremony time/venue/parking/dress-code) so the responder answers real
  logistics, not just `event_date`. Today the aggregate is 3 fields; the responder seam is built for it.
- **Period-batched usage billing** (aggregate the meter into one periodic `usage_charge`) — mitigates
  O(messages) ledger growth; needs a billing-period concept.
- **`deliveryStatus` consumption** (observational; the port declares it, no consumer yet).
- **Real provider + real numbers + real recipients** — the human-reserved crossing. Never simulate having it.
