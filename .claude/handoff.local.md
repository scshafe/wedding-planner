# Handoff

## Where things stand — Phase 19 (the guest inbound edge) is COMPLETE ✅
`.claude/plans/2026-06-26-phase-19-guest-inbound-edge.md` is **complete — Step 0 design reviews + Steps 1–4
ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3–19
build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**695 tests**, up from 651 at the start of this run).

This phase wired rung +1 of the **human-set guest-messaging channel**
([[guest-messaging-channel-is-a-roadmap-goal]]): the **guest inbound HTTP edge** — a guest texts in via a
provider webhook, a product-side deterministic responder answers from the guest's bound wedding, and the reply
goes out through `MessagingService.send` — **the FIRST time the Phase-18 meter fires from a real request**. End
-to-end, offline, demoable. ADR 0019, memory [[guest-messaging-inbound-edge]].

## What changed this phase — the inbound edge (the meter's first request-pipeline trigger)
- **`product/src/auth/provider_webhook_credential.ts`** — the **4th trust tier** (mirrors Operator: phantom
  WeakSet brand + sole-mint store + bare `Map.get` resolve, no shape gate). Platform-level shared secret; a
  4th token namespace that never crosses session/operator.
- **`product/src/messaging/guest_registry.ts`** — `GuestRegistry`: per-tenant `recipient_ref →
  {wedding_id, guest_id}`, keyed on `from_ref` ALONE — **the segmentation gate**. COMPOSES
  `TenantScopedRepository` (isolation inherited, not re-implemented). A guest is NOT a session Principal.
- **`product/src/messaging/inbound_receipt_log.ts`** — `InboundReceiptLog`: the **reply-cardinality firewall**.
  Records refs already-replied-to per tenant; the send idempotency key is platform-minted (`mintReplyId`),
  NEVER the provider ref; **commit-after-success** (`seen`/`markReplied`).
- **`product/src/messaging/guest_qa_responder.ts`** — `GuestQaResponder` (swap seam) +
  `DeterministicGuestQaResponder` + `projectGuestVisibleFacts` (**deny-by-fact-classification**: explicit
  allow-list, no spread). No loop import. Trivial impl: answer `event_date`, else escalate.
- **`product/schemas/inbound_webhook_schema.json`** — the **17th** contract (the provider wire shape);
  `RawInboundPayload` is now a type alias of the generated `InboundWebhook`; `channel` drift-guarded.
- **`product/src/http/product_api.ts`** — the `messaging` branch (webhook-auth first → `dispatchMessaging` →
  `handleInbound`), the **uniform 202** (`RESP_ACCEPTED`), `MessagingHandlerDeps` (OPTIONAL, mirrors
  `championStrategy`).
- **`compose.ts`** wires it + **seeds one demo guest** (`demo.guestRecipientRef`); **`app/server_config.ts`**
  generalized the credential-token policy to one `resolveCredentialToken` for both `WP_OPERATOR_TOKEN` and the
  new `WP_PROVIDER_WEBHOOK_TOKEN`.

## The load-bearing insights (carry forward) — see [[guest-messaging-inbound-edge]] for the full set
- **Bill from OUR record; the provider can't move reply cardinality.** The per-tenant `seen` gate + a
  platform-minted send key close re-delivery double-charge/suppression (doddy P0). **Commit-after-success**: a
  send failure stays retryable and the edge swallows the structured error to the uniform 202 — never a 500
  oracle or a suppressed message (doddy P1).
- **Uniform 202 on EVERY post-validation branch** (no registry-state disclosure; doddy P1). Residuals:
  reply-vs-silence + timing (inherent/offline; flagged for going-live).
- **Segmentation = the registry binding + two gates** (context + `wedding_id`, no id-alone key). Identity comes
  from trusted state ONLY (stored `recipient_ref` + bound `wedding_id`), never a body field;
  `additionalProperties:false` blocks body-smuggling.
- **`handleInbound` order is load-bearing:** validate → normalize → `seen` (before any read) → segment →
  scoped wedding load → responder → send → `markReplied`.

## Next action — your call. Pick the next high-value lever (ranked)
- **★ CONTINUE THE GUEST-MESSAGING CHANNEL — rung +2: per-message cost into the North-Star denominator
  (constraint 1's scoring half).** Make per-message cost a `money_cost` term so the AI's comms strategy
  (cadence/spacing/batching — the Phase-5 tier-1 knobs) trades REAL money in the objective, not only guest
  attention. A substantial INWARD rung: touches the genome / simulator Stage A&B / a 9th integrity effect kind
  / scoring — mirror the trusted-reconciliation pattern of Phases 6–10 (see the `*-trusted-reconciliation`
  memories). This is the **last unbuilt half of the channel's two human-set constraints** (constraint 2,
  no-lock-in, is done; constraint 1's product-pricing half is done — only its scoring half remains). High value.
- **★ CONTINUE — planner-facing guest-management CRUD + the first browser-form CSRF.** Today guests are seeded
  in compose; a planner needs an authenticated surface to register/list/remove guests. This folds naturally
  with the long-deferred **HTML create/update forms + CSRF** (the first planner *mutation* trust surface — the
  browser-form anti-forgery that Phase 19 deliberately distinguished from the webhook shared secret). Makes the
  channel operable by a real planner, not just seeded.
- **A richer wedding-facts model** (ceremony time / venue / parking / dress code) so the responder answers real
  logistics, not just `event_date`. The `GuestQaResponder` seam + `projectGuestVisibleFacts` are built for it;
  this is where `'refused'` (surprise-classified facts) finally gets emitted. Smaller; high demo value.
- **Period-batched usage billing / `deliveryStatus` consumption** — smaller billing/observability rungs (see
  ADR 0019 "Deferred"). Lower priority than the rungs above.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not
provisioned** here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this
run did, at design AND on the built code — both APPROVE-WITH-CHANGES, every must-fix applied). **CI/exit-code
lesson:** never pipe `npm run build` to tail/grep when gating with `&&` (the pipe masks the non-zero exit); run
build standalone, check `$?`. `npm run build` runs from REPO ROOT. **Schema change ⇒ `npm run gen:types`** to
regenerate the contract type (and bump the manifest count + its tests).
