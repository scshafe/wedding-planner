---
name: guest-messaging-port-and-meter
description: Phase 18 — the guest-messaging channel's FOUNDATION: a provider-agnostic MessagingPort + offline simulated adapter + usage-metered, margin-priced tenant billing (usage_charge) folded into the Phase-15 ledger. Server-side only; defers the guest persona/HTTP edge and the inward North-Star wiring.
metadata:
  type: project
---

Phase 18 opened the human-set guest-messaging channel ([[guest-messaging-channel-is-a-roadmap-goal]]) by
building its FOUNDATION — the provider boundary + the meter — satisfying the **product-side** of both
non-negotiable constraints. Server-side domain + billing only; **deferred**: the guest persona/HTTP edge
(rung +1) and the inward North-Star denominator wiring (rung +2). ADR 0018.

**The two constraints, realized:**
- **No vendor lock-in** → `product/src/messaging/messaging_port.ts`: a provider-agnostic, channel-agnostic
  `MessagingPort` declaring all four ops (`send`/`deliveryStatus`/`inbound`/`costReport`) with NO carrier
  concepts (no SID/E.164/segments). `recipient_ref` + `provider_message_ref` are OPAQUE; medium is the
  canonical `Channel`. Offline `SimulatedMessagingAdapter` (deterministic double, injected clock/ids). A real
  provider sending real texts is the human-reserved crossing — built up to the line, never across.
- **Pricing is first-class** → metered, margin-priced. `price_book.messagePriceCents(channel, plan_tier)`
  (total over Channel×PlanTier, higher tiers discounted so plan_tier moves the price); `usage_charge` billing
  kind accrues the owed balance.

**THE FIREWALL (the doddy crux — load-bearing):** we bill from OUR record of accepted sends, NEVER the
provider's word. `MessagingService.send` computes `usage_charge.amount_cents = messagePriceCents(
outbound.channel, tenant.plan_tier)` from the REQUEST channel + the `plan_tier` read from the trusted
`TenantStore` — never a receipt/cost-report field (a hostile adapter echoing a different channel cannot move
the bill; tested). The provider's `costReport` is COGS only: validated as a non-negative safe integer
(never coalesced) BEFORE a STRICT margin gate (break-even throws). `deliveryStatus` is observational (no
meter/ledger path; no auto-refund). `provider_message_ref` is opaque/reconciliation-only; the platform
`message_id` is minted from injected ids.

**Load-bearing invariants (carry forward):**
- **Idempotency is PER TENANT** — the dedupe index is nested INSIDE the `#`-private per-tenant partition, so a
  key is meaningless across tenants (two tenants sharing a key → independent receipts + charges, neither sees
  the other's). A global key map would be a cross-tenant receipt oracle + charge-suppression hole. Key must be
  non-empty; check-and-record is one synchronous critical section.
- **`usage_charge` ACCRUES, is NOT lifecycle-settled.** Unlike the monthly `charge`+`payment` pair, it has no
  paired payment — the balance goes owed (the point of metering). `reactivate`'s `#chargeAndPay` settles only
  the PLAN FEE, so a reactivated tenant still carries accrued usage (pinned by test). `suspend` doesn't read
  the balance → usage is reported, not yet enforced; `send` is allowed regardless of lifecycle this rung.
  Usage *collection/settlement* is a later rung.
- **The financial-kind rule moves in lockstep across FOUR sites** — `billing_event` schema `kind` enum + the
  per-kind `allOf` `if`, `FINANCIAL_KINDS`, AND the `balanceCents` fold (which HARD-CODES the per-kind debit
  direction, it does NOT iterate the set). Touch one without the others = a silent money bug (validates-but-
  doesn't-fold, or folds-but-rejects-the-write). Round-trip + reverse tests pin it.
- **The two writes per send are transactional-on-success** — the throwing write (`billing.record`, runs the
  schema check) FIRST, then the in-memory appends (which can't throw), so a failure leaves NEITHER. Invariant:
  meter billed-total === Σ(tenant `usage_charge` amounts) (tested).
- **No 17th schema this rung** — `usage_charge` rides the EXISTING `billing_event` money contract; the
  per-message detail lives in the in-process messaging meter (a branded object like `SessionStore`, not a wire
  shape). Revisit trigger (→ then add a schema): inbound accepted over HTTP / meter persisted across a trust
  boundary / a stable external wire shape / tenant-overridable. The **inbound** untrusted-edge schema + CSRF
  belong with the persona/HTTP rung (the port declares `inbound`; nothing consumes it over the wire yet).
- **Canonical `Channel`** lives in `shared/src/domain/channel.ts`, DERIVED from the `event_payloads` schema
  (no third inline copy), CI drift-guarded against the `guest_persona` schema. The repo deliberately uses
  self-contained schemas with NO cross-file `$ref` — so canonicalize by derivation + a drift guard, NOT by a
  `$ref`'d shared definition.
- **Determinism rail intact** — the simulated adapter is a deterministic double taking the injected clock/ids,
  so it wires at the composition root like any dep; `MessagingService` is exposed on `ComposedSurface` (a
  compose test sends through the wired graph), with NO HTTP route yet. New error codes
  `PRODUCT.PROVIDER_COST_INVALID` / `PRODUCT.MARGIN_VIOLATION` are server-side invariant violations → 500
  (code-free) via errorToResponse's default; correct since no client path constructs them.

**Per-message `usage_charge` ⇒ O(messages) ledger+meter growth** — designed, maximally auditable; period-
batched usage billing is the recorded mitigation (needs a billing-period concept). doddy + architect APPROVE
at design AND built. 651 tests green.
