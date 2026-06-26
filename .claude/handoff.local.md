# Handoff

## Where things stand — Phase 18 (the guest-messaging provider boundary + the meter) is COMPLETE ✅
`.claude/plans/2026-06-26-phase-18-messaging-port-and-meter.md` is **complete — all 6 steps ticked** (Step 0
design reviews + Steps 1–5), on branch **`build/phase-3-generalize-search`** (the open review artifact for
`main`; Phases 3–18 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**651 tests**, up from 617 at the start of this run).

This phase opened the **human-set guest-messaging channel** ([[guest-messaging-channel-is-a-roadmap-goal]]) by
building its **foundation** — the provider boundary + the meter — satisfying the **product-side** of both
non-negotiable constraints. ADR 0018, memory [[guest-messaging-port-and-meter]].

## What changed this phase — the boundary + the meter
- **`shared/src/domain/channel.ts`** — the single canonical `Channel` (+ `CHANNELS`), DERIVED from the
  `event_payloads` schema, CI drift-guarded against `guest_persona` (no third inline copy; the repo uses
  self-contained schemas with no cross-file `$ref`, so canonicalize by derivation + guard).
- **`product/src/messaging/messaging_port.ts`** — the provider-agnostic `MessagingPort`
  (`send`/`deliveryStatus`/`inbound`/`costReport`) + domain types. No carrier concepts; opaque
  `recipient_ref`/`provider_message_ref`; channel-agnostic.
- **`product/src/messaging/simulated_messaging_adapter.ts`** — the offline deterministic adapter (injected
  clock/ids, no network) + per-channel COGS.
- **`product/src/messaging/messaging_service.ts`** — the meter + margin + bill (THE FIREWALL): per-tenant
  idempotency, untrusted-cost validation, strict margin, bill from the request channel + trusted plan_tier,
  transactional meter + `usage_charge`, `usageView`.
- **`product/src/billing/price_book.ts`** — `messagePriceCents(channel, plan_tier)` (total, tier-discounted,
  margin invariant). **`billing_event` schema + `billing_ledger.ts`** — the `usage_charge` financial kind
  (accrues owed) across schema enum + `allOf` + `FINANCIAL_KINDS` + the `balanceCents` fold (regenerated
  contract). **`product_error.ts`** — `PROVIDER_COST_INVALID` / `MARGIN_VIOLATION`.
- **`product/src/runtime/compose.ts`** — wires the adapter + service (determinism rail held), exposes
  `messaging` on `ComposedSurface`. **No HTTP route yet** (the guest edge is the next rung).

## The load-bearing insights (carry forward) — see [[guest-messaging-port-and-meter]] for the full set
- **Bill from OUR send record, NEVER the provider's `costReport`.** `usage_charge.amount_cents =
  messagePriceCents(outbound.channel, tenant.plan_tier)` — request channel + trusted `TenantStore` plan_tier;
  a hostile adapter echoing a different channel can't move the bill. `costReport` is COGS-only (validated
  non-negative integer BEFORE a STRICT margin gate; break-even throws). `deliveryStatus` observational (no
  auto-refund). The messaging analogue of the trusted-evidence firewall.
- **Idempotency is PER TENANT** (key nested in the `#`-private partition) — else a cross-tenant receipt
  oracle + charge-suppression. **`usage_charge` ACCRUES, not lifecycle-settled** (`reactivate` settles only the
  plan fee; `suspend` doesn't read the balance). **The financial-kind rule moves in lockstep across 4 sites**
  (schema enum + `allOf` + `FINANCIAL_KINDS` + the hard-coded fold). **Two writes/send transactional** (throwing
  write first; meter-total === Σ usage_charge).
- **No 17th schema this rung** — `usage_charge` rides `billing_event`; the per-message detail is the in-process
  meter. Revisit trigger: inbound over HTTP / meter persisted across a trust boundary / stable external wire
  shape / tenant-overridable.

## Next action — your call. Pick the next high-value lever (ranked)
- **★ CONTINUE THE GUEST-MESSAGING CHANNEL — rung +1: the guest persona + the inbound HTTP edge.** The port
  declares `inbound` but nothing consumes it over the wire. This rung adds **guest** as a new UNTRUSTED product
  persona (today only planner|couple in `principal.ts`) with structural ownership (like couple), a validated
  inbound edge route (the **inbound schema + CSRF** land here — the recorded deferral), and wires the AI Q&A
  reply (the existing `guest.question.answered` model + the comms gates) + an OUTBOUND send path that calls
  `MessagingService.send` (the meter finally gets a real request-pipeline trigger). Guest = a doddy-shaped
  untrusted persona → ride the existing 5-stage pipeline + the disclosure mask; verify with doddy. **This is
  the natural next rung and unblocks the channel becoming demoable end-to-end.**
- **★ CONTINUE — rung +2: per-message cost into the North-Star denominator (constraint 1's scoring half).**
  Make per-message cost a `money_cost` term so cadence/spacing/batching trade real money in the objective.
  Touches the genome / simulator Stage A&B / a 9th integrity effect kind / scoring — a substantial INWARD rung
  (mirror the trusted-reconciliation pattern of Phases 6–10; see the `*-trusted-reconciliation` memories). Can
  be done before or after rung +1; +1 makes the channel demoable, +2 makes the strategy cost-aware.
- **Period-batched usage billing** — a single periodic `usage_charge` aggregating the meter (mitigates the
  O(messages) ledger growth). Smaller; needs a billing-period concept. Lower priority than the rungs above.
- **Other open levers (unchanged from before):** HTML create/update forms + CSRF (folds naturally into the
  guest inbound edge — the first mutation trust surface); the operator web console over the Phase-15 `/admin`
  JSON; per-tenant strategy selection / a live publish pipeline (deepen the Phase-17 seam). See git history.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build the port up to
the line, never across it or simulate having.** Building the image is in-scope; running it for real is the
human crossing. Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The
named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route
adversarial reviews through `general-purpose` agents carrying the persona lens (this run did, at design AND on
the built code — both APPROVE). **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep
when gating with `&&` (the pipe masks the non-zero exit); run build standalone, check `$?`. `npm run build`
runs from REPO ROOT. **Schema change ⇒ run `npm run gen:types`** to regenerate the contract type.
