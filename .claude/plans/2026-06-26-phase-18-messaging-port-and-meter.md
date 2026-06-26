# Phase 18 — The guest-messaging provider boundary + the meter (the channel's foundation)

**Status:** IN PROGRESS
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
   **opaque `provider_message_ref`**, and `channel` **reuses the existing canonical enum** (`email | sms |
   whatsapp | postal | phone`, already in `guest_persona` / `event_payloads` — never redefined). A second
   adapter could be dropped in with zero domain change; that substitutability *is* the anti-lock-in property.

2. **The meter is OUR record of accepted sends — NEVER the provider's cost-report (the doddy crux).** What
   we **bill the tenant** is metered from the platform's own count of accepted sends × the **tenant price**
   (`price_book`). The port's `costReport` reports what the **provider charges us** (the platform's COGS) and
   is used **only** to (a) assert margin and (b) record COGS for reconciliation — it **never** sets the
   tenant's bill. An untrusted/buggy/compromised provider must not be able to move a customer's invoice. This
   is the messaging analogue of the trusted-evidence firewall: provider = untrusted external system; our send
   record = the trusted basis for billing.

3. **Margin is enforced structurally, fail-closed.** At send time the service asserts
   `tenantPriceCents(channel, plan_tier) > providerCostCents(channel)` (from the `costReport`); a
   non-positive margin **throws** (`PRODUCT.*`) and the send does **not** meter/charge. We never knowingly
   sell messaging at a loss. This makes "price it with margin" a load-bearing invariant, not a comment.

4. **Send is idempotent — no double-charge.** A send carries a caller-supplied **idempotency key**; a repeat
   with the same key returns the prior receipt and **does not** meter or bill again (mirrors the existing
   `integration` idempotency_key discipline). Metering is **append-only** and **tenant-partitioned** (a
   `#`-private per-tenant map, exactly like `BillingLedger` — an operator/tenant never sees another tenant's
   messaging meter). Tenant-isolation and the disclosure mask are inherited unchanged.

5. **No new JSON Schema this rung — usage rides the EXISTING `billing_event` money contract.** Each accepted
   send records ONE `usage_charge` **billing_event** (the 17th value in the *kind enum*, not a 17th schema):
   `usage_charge` is **financial** (carries `amount_cents` = the billed margin price) and **accrues** the
   owed balance (positive = owed) — metered usage made visible in the operator `/admin/.../billing` view via
   the existing fold. The per-message operational detail (channel, `provider_message_ref`, provider COGS,
   billed cents) lives in the **in-process messaging meter** (a branded domain object like `SessionStore` /
   `Principal`, not a persisted cross-trust wire contract). The **inbound untrusted-edge schema** is deferred
   to the persona/HTTP rung that actually accepts inbound over the wire — adding it now (no route consumes
   it) would be speculative. Revisit trigger recorded in the ADR (persist the meter across a trust boundary /
   stabilize an external wire shape / accept inbound over HTTP ⇒ then it needs a schema).

6. **The simulated adapter is deterministic, not an ambient edge.** Because it takes an **injected** clock/ids
   and fabricates nothing from the real world, it is a pure double — it can live in `product/src/messaging/`
   and be injected at the composition root like the other deps (unlike `SystemClock`/`RandomIdGenerator`,
   which are real-reality edges quarantined under `runtime/`). The determinism rail is unaffected; the eval/
   loop core still imports no `product` code. The service is constructed and injected at compose to prove the
   wiring; its **request-pipeline trigger** (who calls `send` over HTTP) arrives with the guest-channel rung.

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

## Steps

- [ ] **Step 0 — Design reviews (architect + doddy lenses); fold outcomes above before code.**
- [ ] **Step 1 — The provider-agnostic port + domain types.**
  - `product/src/messaging/messaging_port.ts`: the `MessagingPort` interface (`send`, `inbound`,
    `deliveryStatus`, `costReport`) + the domain types (`OutboundMessage`, `SendReceipt`, `DeliveryStatus`,
    `InboundMessage`, `ProviderCostReport`). Channel reuses the shared enum; recipient/provider handles are
    opaque refs; **no carrier concepts**. Pure types/interface, no impl. Export from the product barrel.
  - Tests: a compile-level/structural test pinning the port shape + that `channel` is the shared enum (a
    carrier-concept regression guard).
- [ ] **Step 2 — The offline simulated adapter.**
  - `product/src/messaging/simulated_messaging_adapter.ts`: a deterministic `MessagingPort` (injected
    clock/ids; fabricates nothing). `send` returns a receipt with an opaque `provider_message_ref`;
    `deliveryStatus` returns a deterministic status; `inbound` accepts/echoes a validated inbound shape;
    `costReport` returns a per-channel provider cost (the COGS the service reads for margin). No network, no
    real-world reads.
  - Tests: `product/tests/messaging/simulated_messaging_adapter.test.ts` (deterministic send/receipt/status;
    per-channel cost report; idempotent ref under the same key).
- [ ] **Step 3 — The price book extension + metered billing kind.**
  - `price_book.ts`: add the **tenant** per-message price (per channel, integer cents) — `messagePriceCents`
    — and a documented **margin invariant** relative to the provider COGS. Keep it total over the channel enum.
  - `billing_event_schema.json`: add `usage_charge` to the `kind` enum and to the financial set in the
    `allOf` (requires `amount_cents`); update the description (metered messaging usage, accrues owed balance).
    Regenerate the contract (`npm run gen:types`).
  - `billing_ledger.ts`: add `usage_charge` to `FINANCIAL_KINDS` and to the `balanceCents` fold (charge side).
  - Tests: schema accepts a valid `usage_charge` (and rejects it without `amount_cents`); the fold counts it
    as owed; existing billing tests stay green.
- [ ] **Step 4 — The MessagingService (meter + margin + bill).**
  - `product/src/messaging/messaging_service.ts`: tenant-scoped `send` that (1) reads `costReport` for the
    channel, (2) asserts margin fail-closed, (3) is **idempotent** by key (replay returns the prior receipt,
    no re-meter/re-bill), (4) appends to the **tenant-partitioned messaging meter** (channel, provider_ref,
    provider COGS cents, billed cents), and (5) records ONE `usage_charge` billing_event (billed cents). A
    `usageView(tenant_id)` summary (count + billed/COGS totals + margin) for the operator surface; partitioned
    strictly by tenant_id (no cross-tenant leak).
  - Tests: `product/tests/messaging/messaging_service.test.ts` — send meters + charges once; replay no-ops;
    margin-violation throws and records nothing; meter is tenant-partitioned; `usage_charge` lands in the
    ledger and moves the owed balance; provider cost never sets the billed amount.
- [ ] **Step 5 — Compose wiring + built-code re-review + ADR 0018 + memory + handoff.**
  - `compose.ts` (+ `app/server.ts`): construct the `SimulatedMessagingAdapter` + `MessagingService` and
    inject them, proving the wiring and the determinism rail (adapter takes the injected clock/ids). No HTTP
    route yet (documented deferral). Add no env reads in compose.
  - Re-run both lenses on the BUILT code; fold any P2s.
  - `docs/adr/0018-*.md`; `.claude/memory/guest-messaging-port-and-meter.md` + MEMORY.md index; update
    `.claude/handoff.local.md`. Commit per verified step throughout.

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
