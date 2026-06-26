# ADR 0018 — The guest-messaging provider boundary + the meter

- **Status:** accepted
- **Date:** 2026-06-26
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-26-phase-18-messaging-port-and-meter.md`)
- **Scope:** Phase 18 — the **foundational rung** of the human-set guest-facing messaging channel
  ([[guest-messaging-channel-is-a-roadmap-goal]]). It builds the **provider boundary** (a provider-agnostic
  `MessagingPort` + an offline simulated adapter) and the **meter** (usage-metered, margin-priced tenant
  billing folded into the Phase-15 ledger). It is **server-side domain + billing only**: the guest persona /
  HTTP surface and the inward North-Star denominator wiring are deferred to the next two rungs.
- **Builds on** ADR 0015 (the simulated billing ledger + the operator tier) and 0016 (the composition root +
  imperative shell). It adds **no parallel safety model**: the meter reuses the trusted-evidence firewall
  (provider = untrusted; our send record = the trusted billing basis), the disclosure mask, and tenant
  isolation by construction, all unchanged.

## Context

The roadmap names a guest-facing messaging channel (guests text the AI for info/Q&A) with **two
non-negotiable, human-set design constraints**: (1) **pricing is first-class** — messaging is metered, priced
with margin, and per-message cost eventually trades against the North Star; (2) **no vendor lock-in** — the
provider sits behind a provider-agnostic port (send / inbound / delivery-status / cost-report) with swappable,
offline-simulated adapters and no carrier concepts in the domain. The two are synergistic: the port's
`cost-report` is what makes switching providers *on price* possible.

This is a large, multi-rung arc. Building the persona/UI and the inward scoring change at once would entangle
an untrusted HTTP edge, a new schema, and a deep change to the genome/simulator/scoring with the boundary
itself. So this rung builds the **boundary + the meter** first — fully realized and tested, server-side — so
the persona rung lands on a solid foundation.

## Decision

**1. A provider-agnostic, channel-agnostic `MessagingPort` is the no-lock-in deliverable.** It declares all
four operations the constraint names — `send`, `deliveryStatus`, `inbound`, `costReport` — in terms that carry
**no carrier concepts** (no Twilio SID, no E.164 parsing, no segment counts). The recipient is an opaque
`recipient_ref`; the provider's handle is an opaque `provider_message_ref` used for **reconciliation only**;
the medium is the single canonical `Channel`. A second adapter drops in with zero domain change — that
substitutability *is* the anti-lock-in property. The only adapter this rung ships is the deterministic offline
`SimulatedMessagingAdapter` (a real provider sending real texts is the human-reserved crossing).

**2. The meter is OUR record of accepted sends — never the provider's cost-report (the firewall).** What a
tenant is billed is `usage_charge.amount_cents = messagePriceCents(outbound.channel, tenant.plan_tier)`,
computed from the **request channel** and the tenant's `plan_tier` read from the trusted `TenantStore` — never
from any field on the receipt/cost-report. The provider's `costReport` is the platform's **COGS**: validated
as a non-negative integer, used only to assert margin and record reconciliation; it cannot move a customer's
invoice. `deliveryStatus` is **observational** (no path to meter/ledger; a failed delivery does not
auto-refund). So an untrusted/buggy/compromised provider can at worst make us refuse to send or eat margin —
never inflate a tenant's bill.

**3. Margin is enforced fail-closed; provider cost is validated as untrusted input first.** Before any
mutation: validate `cost_cents` is a non-negative safe integer (never coalesce missing/NaN/negative to 0),
then assert **strictly** `tenant_price > provider_cost` (break-even throws — we never knowingly sell at a
loss). `messagePriceCents` is total over `Channel × PlanTier`; higher tiers are discounted so `plan_tier`
genuinely moves the price.

**4. Send is idempotent PER TENANT.** The idempotency index is keyed by the caller's `idempotency_key`
**nested inside the tenant's `#`-private partition**, so a key is meaningless across tenants — two tenants
reusing a key get independent receipts and independent charges, and neither can read the other's. The key must
be a non-empty string; check-and-record is one synchronous critical section (no double-charge).

**5. Usage rides the EXISTING `billing_event` contract — no 17th schema this rung.** `usage_charge` is a new
value in the `kind` enum (a financial kind that **accrues** the owed balance, unlike the monthly
`charge`+`payment` settle pair) — added to the schema enum, the schema's per-kind `allOf`, `FINANCIAL_KINDS`,
and the `balanceCents` fold **together**. The per-message operational detail (channel, opaque provider ref,
COGS, billed cents) lives in an in-process messaging meter — a branded domain object like `SessionStore`, not
a persisted cross-trust wire shape. The two writes per send (meter append + `usage_charge` record) are
**transactional-on-success**: the throwing write runs first, so a failure leaves neither; meter-total ===
Σ(`usage_charge`) is an invariant test.

**6. The simulated adapter + service wire at the composition root.** The adapter is a deterministic double
(injected clock/ids, no network), so it injects like any dep without breaching the determinism rail; the
service is exposed on `ComposedSurface` for tests. There is **no HTTP route yet** — nothing reaches `send`
over the wire; the guest-channel request edge is the next rung.

## Consequences

- **Both human-set constraints have a real, tested product-side foundation.** Pricing is metered with a
  fail-closed margin; the provider sits behind a swappable, carrier-concept-free port.
- **Per-message `usage_charge` ⇒ the ledger (and the meter) grow O(messages) per tenant.** This is the
  designed, maximally-auditable first model. For the offline/demo image it is fine; **period-batched usage
  billing** (a single periodic `usage_charge` aggregating the meter) is the natural mitigation and is a
  recorded deferral — it needs a billing-period concept this rung does not have.
- **No new oracle, no widened boundary.** `send`/`usageView` require the tenant to exist (pricing reads the
  trusted plan_tier) and throw the same masked `UNKNOWN_TENANT` as the rest of the surface; `suspend` still
  does not read the balance, so accrued usage is reported, not yet enforced.

## Revisit triggers (the no-new-schema decision)

Add a messaging schema when any of these becomes true: the **inbound** payload is accepted over an HTTP edge
(it then needs edge validation + CSRF — the guest-channel rung), the messaging meter is **persisted across a
trust boundary** or becomes a **stable external wire shape**, or a message record becomes **tenant-overridable
config**. Until then the `billing_event` contract (the money) is the source of truth and the meter is in-process.

## Alternatives considered

- **Bill from the provider's cost-report.** Rejected — it lets an untrusted external system set customer
  prices; the firewall requires billing from our own trusted record.
- **A `$ref`'d shared `channel` schema definition.** Rejected — the repo deliberately uses self-contained
  schemas with no cross-file `$ref`; a derived canonical `Channel` + a CI drift guard honors that convention
  without a third inline copy.
- **Do the whole channel (persona + UI + North-Star) in one phase.** Rejected — it entangles an untrusted edge
  and a deep scoring change with the boundary; building the boundary + meter first is the right dependency
  order.
- **Auto-settle `usage_charge` with a paired payment (like the monthly fee).** Rejected — it would hide the
  metered usage; accrual to an owed balance is the honest model and the point of metering.

## Verification

`npm run build && npm test && npm run lint` green at every step (651 tests, up from 617). Both adversarial
lenses (rigorous-architect + doddy) reviewed at design AND on the built code: **both APPROVE**, every P0/P1/P2
fold verified closed, nothing exploitable. Memory: [[guest-messaging-port-and-meter]].
