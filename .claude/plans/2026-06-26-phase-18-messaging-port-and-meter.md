# Phase 18 — The guest-messaging provider boundary + the meter (the channel's foundation)

**Status:** IN PROGRESS — Step 0 complete (both lenses APPROVE-WITH-CHANGES; folded). Steps 1–5 pending.
**Branch:** `build/phase-3-generalize-search` (the open review artifact for `main`; Phases 3–17 build on it; this continues it)
**Predecessor:** Phase 17 (the engine↔surface strategy seam) — complete, 617 tests green.

## Goal

Open the **guest-facing messaging channel** (the human-set strategic roadmap goal,
[[guest-messaging-channel-is-a-roadmap-goal]]) by building its **foundation**: a **provider-agnostic
messaging port** + an **offline-simulated adapter**, and **usage-metered, margin-priced tenant billing**
folded into the existing ledger. This is the rung that satisfies the *product-side* of **both** human-set
non-negotiable constraints:

1. **Pricing is first-class.** Messaging is **metered** — each accepted send is metered from *our* record
   and **billed to the tenant with a margin** over the provider's reported cost, extending the flat-monthly
   `price_book` + the Phase-15 ledger.
2. **No vendor lock-in.** A **provider-agnostic `MessagingPort`** (`send` / `inbound` / `deliveryStatus` /
   `costReport`), channel-agnostic, **no carrier concepts in the domain**, with a **swappable, offline-
   simulated adapter**. The port's `costReport` is what makes *switching providers on price* possible — the
   two constraints are synergistic.

This rung is **server-side domain + billing only.** It deliberately **defers** (a) the **guest persona +
HTTP surface** (guests aren't a product persona yet; inbound over the wire is the next rung) and (b) the
**inward North-Star denominator wiring** (constraint 1's *scoring* half — making cadence/spacing/batching
trade real money in the objective). Those are the next two rungs; see Recorded deferrals. Building the
boundary + the meter first means the persona rung lands on a real, tested foundation.

## The hard rails (unchanged — CLAUDE.md)

Offline-first. **No real provider, no real texts, no real money.** The simulated adapter sends nothing —
it is deterministic, takes an **injected clock/ids**, and fabricates no network state. A **real provider
sending real texts is the human-reserved crossing** (guest-comms tier-2) — we build *up to* the port, never
across it, and never simulate having crossed it. Money is **integer cents, never a float**. One safety
model (reuse, never a parallel one). Don't modify `ops/` or `CLAUDE.md`. Push only to `origin`.

## The crux design decisions (to be ratified by the Step-0 reviews)

1. **The port is provider-agnostic and channel-agnostic — the no-lock-in contract is the deliverable.**
   `MessagingPort` declares all four operations the constraint names (`send`, `inbound`, `deliveryStatus`,
   `costReport`). Domain types carry **no carrier concepts** — no Twilio SID, no E.164/segment specifics, no
   provider-proprietary fields. The recipient is an **opaque `recipient_ref`**, the provider's handle is an
   **opaque `provider_message_ref`** (used for reconciliation ONLY — never a platform identity or dedupe key;
   all platform ids come from the injected `IdGenerator`), and `channel` references a **single canonical
   `Channel`** type. **Channel canonicalization (architect P1-1):** there is today no importable `Channel` —
   the enum `email|sms|whatsapp|postal|phone` is duplicated *inline* in two generated files
   (`guest_persona`, `event_payloads`), each derived from its own self-contained schema. The repo
   **deliberately uses self-contained schemas with zero cross-file `$ref`** (verified), so a `$ref`'d shared
   definition would fight that convention. Instead, add **ONE** canonical `Channel` to the shared barrel
   (`shared/src/domain/channel.ts`), **drift-guarded** by a type-equality test against the schema-generated
   `event_payloads`/`guest_persona` unions (schemas stay the source of truth; any enum drift fails CI).
   Messaging references that canonical `Channel` — **no third inline copy.** A second adapter drops in with
   zero domain change; that substitutability *is* the anti-lock-in property.

2. **The meter is OUR record of accepted sends — NEVER the provider's cost-report (the doddy crux).** What
   we **bill the tenant** is `usage_charge.amount_cents = tenantPriceCents(outbound.channel, tenant.plan_tier)`
   — computed from the **request** `OutboundMessage.channel` and the tenant's `plan_tier` read from the
   `TenantStore`, **never** from any field on the `SendReceipt`/`ProviderCostReport` (doddy P1-1: a hostile
   adapter echoing a different channel must not shift the price). The port's `costReport` reports what the
   **provider charges us** (the platform's COGS) and is used **only** to (a) assert margin and (b) record COGS
   for reconciliation — it **never** sets the tenant's bill. `deliveryStatus` is **observational only** — it
   has **no path to the meter or ledger** (no charge created/sized/reversed by it; a "failed" status does NOT
   auto-refund — the `claimed_status` trap). This is the messaging analogue of the trusted-evidence firewall:
   provider = untrusted external system; our accepted-send record = the trusted basis for billing.

3. **Margin is enforced structurally, fail-closed — and the provider cost is validated as untrusted input.**
   At send time, BEFORE any meter/charge mutation: (a) validate `providerCostCents` from the `costReport` is a
   **non-negative safe integer** (`Number.isInteger && >= 0`) — reject missing/NaN/negative/non-integer with
   `PRODUCT.*`, **never coalesce to 0** (doddy P0-2: integer-cents rail at the untrusted edge); (b) assert
   **strictly** `tenantPriceCents(channel, plan_tier) > providerCostCents(channel)` — **break-even throws**
   ("never knowingly sell at a loss" includes zero margin); a failure meters/charges **nothing**.
   `tenantPriceCents` is **total over the `Channel` enum** and fail-closed on an unknown channel.

4. **Send is idempotent, PER-TENANT — no double-charge, no cross-tenant oracle (doddy P0-1).** The
   idempotency index is keyed by `(tenant_id, idempotency_key)` — nested **inside the same `#`-private
   per-tenant partition as the meter**, one isolation boundary. A key is meaningless outside its tenant: two
   tenants using the *same* key get **two independent** receipts and **two** charges, and neither sees the
   other's receipt. The key must be a **validated non-empty string** (absent/empty → `PRODUCT.BAD_REQUEST`,
   never a silent shared bucket). Check-and-record is **one synchronous critical section** (a repeat returns
   the prior receipt and does **not** re-meter/re-bill; documented so a future async refactor can't open a
   double-charge). Metering is **append-only** and **tenant-partitioned** (a `#`-private per-tenant map, like
   `BillingLedger` — no enumeration/serialization leak, no cross-tenant aggregate accessor). Tenant-isolation
   and the disclosure mask are inherited unchanged.

5. **No new JSON Schema this rung — usage rides the EXISTING `billing_event` money contract.** Each accepted
   send records ONE `usage_charge` **billing_event** (the 17th value in the *kind enum*, not a 17th schema):
   `usage_charge` is **financial** (carries `amount_cents` = the billed margin price) and **accrues** the
   owed balance (positive = owed) — metered usage made visible in the operator `/admin/.../billing` view via
   the existing fold. **The two writes per send (meter append + `usage_charge` record) are
   transactional-on-success (architect P1-2):** ordered so a throw leaves **neither** (mirroring
   `onboarding_service`'s "only-throwing-step-first, no partial state"), with an invariant test that a
   tenant's meter billed-total === Σ(its `usage_charge` `amount_cents`). The per-message operational detail
   (channel, `provider_message_ref`, provider COGS, billed cents) lives in the **in-process messaging meter**
   (a branded domain object like `SessionStore` / `Principal`, not a persisted cross-trust wire contract).
   **`FINANCIAL_KINDS`/schema-`allOf`/`balanceCents`-fold must all move together (doddy P1-4):** `balanceCents`
   hard-codes `if kind==='charge'` rather than iterating `FINANCIAL_KINDS`, so Step 3 edits the kind enum, the
   schema `allOf` `if` branch, `FINANCIAL_KINDS`, AND the fold — pinned by a round-trip test (`usage_charge`
   with `amount_cents` persists + moves `balanceCents` by exactly that amount) and a reverse test
   (`usage_charge` sans `amount_cents` throws). The **inbound untrusted-edge schema** is deferred to the
   persona/HTTP rung that actually accepts inbound over the wire — adding it now (no route consumes it) would
   be speculative. Revisit trigger recorded in the ADR (persist the meter across a trust boundary / stabilize
   an external wire shape / accept inbound over HTTP ⇒ then it needs a schema).

6. **The simulated adapter is deterministic, not an ambient edge.** Because it takes an **injected** clock/ids
   and fabricates nothing from the real world, it is a pure double — it can live in `product/src/messaging/`
   and be injected at the composition root like the other deps (unlike `SystemClock`/`RandomIdGenerator`,
   which are real-reality edges quarantined under `runtime/`). The determinism rail is unaffected; the eval/
   loop core still imports no `product` code. The service is constructed, injected at compose, **and exposed on
   `ComposedSurface`** (architect P2-5) so a compose-level test exercises `send` through the wired graph
   (proving the determinism rail it exists to prove) — not constructed-but-hidden. The adapter's **`inbound`**
   returns a typed `InboundMessage` from **opaque, untrusted** caller data, performs **no real-world read**,
   has **no path to the meter or ledger** (receiving never bills), and is documented as unwired (doddy P2-3).
   Its **request-pipeline trigger** (who calls `send` over HTTP) arrives with the guest-channel rung.

7. **`usage_charge` ACCRUES owed balance; it is NOT settled by the lifecycle (architect P1-3).** Unlike the
   monthly `charge`+`payment` auto-settle pair, a `usage_charge` is a charge with no paired payment — the
   balance genuinely goes positive/owed (the whole point of metering). It is **not** settled by `reactivate`'s
   `#chargeAndPay` (which settles only the **plan fee**), so a reactivated tenant may still carry a usage
   debit — **intended**; usage *collection/settlement* is a later rung. Suspend is operator-driven and does
   **not** read `balanceCents`, so accrued usage is **reported, not yet enforced** (no delinquency oracle, no
   surprise lifecycle move). Pinned by a lifecycle test: accrue a `usage_charge`, `reactivate`, assert the
   balance still reflects the unsettled usage — so a future edit can't silently start forgiving owed usage.
   Policy: `send` is **allowed regardless of lifecycle status** this rung (the fold is monotonic + safe either
   way; gating is a later collection-rung concern) — documented, not gated.

## Step 0 — Design review (adversarial; both lenses must land before code)

Route two `general-purpose` agents carrying the persona lenses (the named sub-agents are not provisioned here):
- **rigorous-architect lens:** Is the port the right boundary (no carrier leakage, channel reuse, the four
  ops well-shaped)? Is "meter from our record, not the cost-report" the right seam? Is "no new schema, ride
  `billing_event`" defensible, or does the persisted meter warrant a contract now? Is constructing/injecting a
  service with no HTTP trigger yet the right altitude, or premature? Is per-message `usage_charge` (vs a
  batched period charge) the right granularity? Is the rung-split (defer persona + North-Star) coherent?
- **doddy lens:** Can the provider's `costReport` ever move a tenant's bill (it must not)? Is the margin
  assertion fail-closed and unbypassable? Is send idempotency double-charge-proof under replay? Is the
  messaging meter tenant-partitioned with no cross-tenant oracle (mirrors the ledger)? Does `usage_charge`
  fold correctly and only into the owed balance? Any carrier/provider field that leaks an external trust
  assumption into the domain? Does anything here add an existence/lifecycle oracle?

Fold both into the steps below before ticking.

## Step 0 — Design review OUTCOME (both APPROVE-WITH-CHANGES; folded into the crux + steps)

**rigorous-architect: APPROVE-WITH-CHANGES.** Core architecture sound — the port boundary, the
trusted-record metering seam (crux #2 "excellent"), the fail-closed margin, the no-new-schema judgment, and
the rung split are all correct. Folds: **(P1-1)** the channel enum is NOT canonical (duplicated inline in two
generated files); promote ONE canonical `Channel` to the shared barrel, drift-guarded vs the generated unions
— BUT the repo deliberately uses self-contained schemas with no cross-file `$ref`, so do this WITHOUT `$ref`
machinery (crux #1). **(P1-2)** meter-write + `usage_charge`-write transactional-on-success; test meter-total
=== Σ(`usage_charge` amount_cents) (crux #5). **(P1-3)** state + test the `usage_charge` accrual / `reactivate`
non-settlement semantics (crux #7). **(P2-4)** pin the `FINANCIAL_KINDS`/fold sync with a round-trip test
(crux #5). **(P2-5)** expose `MessagingService` on `ComposedSurface` + exercise `send` through the composed
graph (crux #6). **(P2-6)** ADR notes per-message `usage_charge` ⇒ O(messages) ledger growth, period-batching
the mitigation.

**doddy: APPROVE-WITH-CHANGES.** Firewall conceptually correct; reuse of `BillingLedger`'s `#`-private
partition + per-kind money rule is the right foundation. **(P0-1)** idempotency index MUST be per-tenant
(`(tenant_id, key)`, nested in the per-tenant partition) — else a cross-tenant receipt oracle + charge
suppression (crux #4). **(P0-2)** validate `providerCostCents` is a non-negative safe integer BEFORE the
margin gate; never coalesce missing/NaN/negative to 0 (crux #3). **(P1-1)** billed amount computed strictly
from `tenantPriceCents(outbound.channel, tenant.plan_tier)`, never a provider/receipt field (crux #2).
**(P1-2)** strictly-positive margin (break-even throws); 0/neg/NaN/missing-channel fail-closed tests (crux #3).
**(P1-3)** key validated non-empty; check-and-record one synchronous critical section (crux #4). **(P1-4)**
schema enum + `allOf` `if` + `FINANCIAL_KINDS` + fold move together, with round-trip + reverse tests (crux #5).
**(P1-5)** `provider_message_ref` opaque, never a platform identity/dedupe key (ids from injected
`IdGenerator`); `deliveryStatus` observational-only, no path to meter/ledger, no-mutation test (crux #2).
**(P2-1)** `usageView` reads exactly one partition, defensive copy, mirrors `billingView`'s existence-guard
decision; no cross-tenant aggregate accessor (Step 4). **(P2-2)** document the suspended-tenant `send` policy
(allowed; fold safe either way) (crux #7). **(P2-3)** adapter `inbound` returns a typed `InboundMessage` from
opaque untrusted data, no real-world read, no path to meter/ledger, documented unwired (crux #6).

## Steps

- [x] **Step 0 — Design reviews (architect + doddy lenses); folded above into the crux + steps.**
- [x] **Step 1 — Canonical `Channel` + the provider-agnostic port + domain types.** (624 tests green)
  - `shared/src/domain/channel.ts`: the **single** canonical `Channel` type (+ a `CHANNELS` tuple), exported
    from the shared barrel. Drift-guard test (`shared/tests/domain/channel.test.ts`): a type-level mutual
    assignability check that `Channel` equals the generated `event_payloads`/`guest_persona` channel unions
    (schemas stay the source of truth; drift fails CI). **(architect P1-1)**
  - `product/src/messaging/messaging_port.ts`: the `MessagingPort` interface (`send`, `inbound`,
    `deliveryStatus`, `costReport`) + the domain types (`OutboundMessage` carrying `channel: Channel`,
    `recipient_ref`, `idempotency_key`; `SendReceipt` with an opaque `provider_message_ref`; `DeliveryStatus`;
    `InboundMessage`; `ProviderCostReport`). Recipient/provider handles are **opaque**; `provider_message_ref`
    documented as reconciliation-only, never a platform id/dedupe key **(doddy P1-5)**; **no carrier
    concepts**. Pure types/interface, no impl. Export from the product barrel.
  - Tests: a structural test pinning the port shape + that `OutboundMessage.channel` is the canonical
    `Channel` (carrier-concept regression guard).
- [ ] **Step 2 — The offline simulated adapter.**
  - `product/src/messaging/simulated_messaging_adapter.ts`: a deterministic `MessagingPort` (injected
    clock/ids; fabricates nothing, no network/real-world read). `send` returns a receipt with an opaque
    injected-id `provider_message_ref` (NOT a real-world ref); `deliveryStatus` returns a deterministic status
    (**observational only — no billing path** (doddy P1-5)); `inbound` returns a typed `InboundMessage` from
    **opaque untrusted** caller data, no real-world read, **no path to meter/ledger**, documented unwired
    **(doddy P2-3)**; `costReport` returns a per-`Channel` provider cost (the COGS the service reads for
    margin) as non-negative integer cents.
  - Tests: `product/tests/messaging/simulated_messaging_adapter.test.ts` (deterministic send/receipt/status;
    per-channel cost report is a non-negative safe integer; `inbound`/`deliveryStatus` mutate nothing).
- [ ] **Step 3 — The price book extension + metered billing kind (all four edits move together).**
  - `price_book.ts`: add the **tenant** per-`Channel` price — `messagePriceCents(channel, plan_tier)` — total
    over the `Channel` enum, fail-closed on an unknown channel, with a documented **margin invariant** vs the
    provider COGS. Integer cents.
  - `billing_event_schema.json`: add `usage_charge` to the `kind` enum **and** to the financial `enum` in the
    `allOf` `if` (so it REQUIRES `amount_cents`); update the description (metered messaging usage; accrues the
    owed balance). Regenerate the contract (`npm run gen:types`).
  - `billing_ledger.ts`: add `usage_charge` to `FINANCIAL_KINDS` **and** to the `balanceCents` fold (charge
    side) — both lists, same step **(doddy P1-4)**.
  - Tests: schema/`record` round-trip (`usage_charge` WITH `amount_cents` persists AND moves `balanceCents` by
    exactly that amount) + reverse (`usage_charge` sans `amount_cents` → `PRODUCT.BAD_REQUEST`); existing
    billing tests stay green.
- [ ] **Step 4 — The MessagingService (meter + margin + bill), with the firewall pinned.**
  - `product/src/messaging/messaging_service.ts`: tenant-scoped `send(tenant_id, outbound)` that, in order:
    (1) validates `outbound.idempotency_key` is a non-empty string and looks it up in the **per-tenant**
    `(tenant_id,key)` index nested in the `#`-private partition — a hit returns the prior receipt, no
    re-meter/re-bill **(doddy P0-1, P1-3)**; (2) reads `costReport(channel)` and validates it is a
    non-negative safe integer, rejecting otherwise **(doddy P0-2)**; (3) computes
    `billed = messagePriceCents(outbound.channel, tenant.plan_tier)` from the **request channel + the
    TenantStore plan_tier** (never a receipt field) **(doddy P1-1)** and asserts **strictly** `billed >
    providerCost` (break-even throws) **(doddy P1-2)**; (4) calls the port `send`; (5) **transactionally**
    appends to the tenant-partitioned meter (channel, opaque provider_ref, COGS cents, billed cents) AND
    records ONE `usage_charge` billing_event (billed cents), ordered so a throw leaves **neither**
    **(architect P1-2)**. `usageView(tenant_id)` reads exactly one partition, returns a defensive copy,
    mirrors `billingView`'s existence-guard (unknown tenant → masked-404 path); **no** cross-tenant aggregate
    accessor **(doddy P2-1)**. `send` is allowed regardless of lifecycle status (documented; fold safe)
    **(doddy P2-2)**.
  - Tests: `product/tests/messaging/messaging_service.test.ts` — send meters + charges once; replay no-ops
    (no second charge); margin-violation / 0 / negative / NaN / missing-channel cost all throw and record
    **nothing**; an adapter echoing a different channel does NOT change the billed amount; two tenants sharing
    a key get two independent receipts + two charges and neither sees the other's; meter billed-total ===
    Σ(`usage_charge` amount_cents); `usage_charge` moves the owed balance; `deliveryStatus`/`inbound` mutate
    no billing/meter state; lifecycle: accrue → `reactivate` → balance still reflects unsettled usage
    **(architect P1-3)**.
- [ ] **Step 5 — Compose wiring + built-code re-review + ADR 0018 + memory + handoff.**
  - `compose.ts` (+ `app/server.ts`): construct the `SimulatedMessagingAdapter` + `MessagingService`, inject
    them (adapter takes the injected clock/ids — determinism rail), and **expose the service on
    `ComposedSurface`** so a compose-level test exercises `send` through the wired graph **(architect P2-5)**.
    No HTTP route yet (documented deferral). No env reads in compose.
  - Re-run both lenses on the BUILT code; fold any P2s.
  - `docs/adr/0018-*.md` (record the no-new-schema revisit trigger + the O(messages) ledger-growth note +
    period-batching as mitigation **(architect P2-6)**); `.claude/memory/guest-messaging-port-and-meter.md` +
    MEMORY.md index; update `.claude/handoff.local.md`. Commit per verified step throughout.

## Verification gate (every step)

`npm run build && npm test && npm run lint` all green before ticking a box or committing (run **build
standalone — never piped to tail/grep** — then check `$?`; `npm run build` runs from REPO ROOT). Commit per
verified step on the branch.

## Recorded deferrals (honest scope edges, not stubs)

- **The guest persona + the inbound HTTP surface** — guests become a product persona (untrusted, structural
  ownership like couple) and text *in* over a validated edge route; this is the NEXT rung and is where the
  **inbound schema** + CSRF/edge-validation land. The port already declares `inbound`; nothing consumes it
  over the wire yet.
- **The North-Star denominator wiring (constraint 1's scoring half)** — making per-message cost a North-Star
  `money_cost` term so cadence/spacing/batching trade real money in the objective. Touches the genome /
  simulator Stage A&B / integrity gate / scoring (a 9th trusted effect kind) — a substantial inward rung of
  its own, deliberately separated from this product-side billing rung.
- **A real provider adapter** — the human-reserved crossing (real texts, real money). Out of scope by rail.
- **Aggregated/period usage billing** — per-message `usage_charge` is the granular, maximally-auditable first
  model; batching into a period charge needs a billing-period concept this rung doesn't have.
