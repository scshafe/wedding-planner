# Handoff

## Where things stand — Phase 26 (guest-escalation inbox) is COMPLETE ✅
`.claude/plans/2026-06-27-phase-26-guest-escalation-inbox.md` is **complete — Step 0 design review +
Steps 1–4 ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`;
Phases 3–26 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**820 tests**, up from 798 at the start of this run).

This rung gives `escalated` a **real downstream surface** (the most product-motivated Phase-25 next-lever):
when a guest texts an **unanswerable** question the responder returns `escalated`, and it is now **recorded** in a
per-tenant, wedding-scoped `EscalationLog`. The couple (their wedding) + planner (whole tenant) **read** it via
JSON `GET /t/:slug/escalations` and a themed read-only `?view=escalations` page — closing the **guest→couple
loop** (gap surfaced → couple fills the field via the Phase-23 edit form → next ask is answered). ADR 0026, memory
[[guest-escalation-inbox]]. doddy + architect APPROVE-WITH-FIXES on the design (**no exploit found**); all fixes
applied in the build.

## What changed this phase
- **19th schema** `product/schemas/guest_escalation_schema.json` + manifest/count-test/gen-script bookkeeping
  (18→19) + `gen:types` emits `GuestEscalation`; barrel-exported from shared + product.
- **`escalation_log.ts`** (new) — `EscalationLog`: a thin face over `TenantScopedRepository<GuestEscalation>`
  **keyed by `provider_message_ref`** (the receipt-log dedup PATTERN reused, read-first-put-if-absent → exactly one
  record per re-delivery). `record` / `list` (planner) / `listForWedding` (couple filter, `undefined → []`).
- **`product_api.ts`** — `handleInbound` records on `outcome.action === 'escalated'` (sourced from the binding +
  the already-validated message, NEVER the raw body; NOT swallowed to 202). New `GET /t/:slug/escalations`
  (`dispatchEscalations` + `handleEscalationList`), scoped by the REUSED `GuestAuthorizer.manageScope`; minimal
  `EscalationHandlerDeps { escalations, authorizer }` (no `weddings`); optional `escalations?` on `ProductApiDeps`.
- **`product_web_ui.ts` + `pages.ts`** — `?view=escalations` read-only page (`#escalationsPage` DELEGATES via
  `api.handle(bearerGet(...))` — NO `escalations` dep on the web UI; `renderEscalations` escapes the untrusted
  `text`; a console nav link). `readEscalations` body reader.
- **`compose.ts`** — ONE `EscalationLog` wired into BOTH `messaging.escalations` (capture) AND the `escalations`
  read deps; exposed on `ComposedSurface`.
- **Tests** — `escalation_log.test.ts` (record/idempotency/scope/isolation/liveness; real port-stamped
  received_at); keystone +4 (escalated records one; answered/refused record zero; re-delivery idempotent);
  `escalation_api.test.ts` (planner all / couple theirs / no sibling leak / tenant isolation / 405 / 401 / answered
  never appears); `pages.test.ts` +3 (renderEscalations renders + empty-state + XSS-escaped); `compose.test.ts` +3
  e2e (the couple loop escalated→fill→answered; stored-XSS escaped; unknown-slug masked 404).

## The load-bearing insight (carry forward) — see [[guest-escalation-inbox]] for the full set
- **Record `escalated` ONLY, NEVER `refused`** (predicate `=== 'escalated'`). `refused` is the fact-independent
  surprise outcome; recording it would persist surprise-probe content. SAFE to omit — the guest wire is unchanged
  (escalated/refused both → uniform 202; record is server-side couple/planner-only). COMMS.SURPRISE_LEAK intact.
- **`guest_escalation.text` is BYTE-IDENTICAL to `inbound_webhook.text`** (`minLength:1`, NO maxLength) so a message
  that passed the inbound edge can never fail `record()` → no 500 oracle → the capture is NOT swallowed to 202.
  `text` is UNTRUSTED → HTML-escaped at render, never reflected to the guest.
- **Idempotency is the receipt-log PATTERN reused, NOT the receipt log widened** — EscalationLog keys its own repo
  by `provider_message_ref`; the doddy-P0 receipt log stays pristine. The two logs dedup DIFFERENT side effects.
- **Reuse `manageScope` for the read; the web page delegates through the JSON read** (no `escalations` dep on the
  web UI — preserves the only-data-path-is-api.handle invariant).

## Next action — your call. Pick the next high-value lever (ranked)
- **Escalation resolution / dismissal** — the natural follow-up: mark an escalation handled. Pinned shape (ADR
  0026 F6): a SEPARATE append-only resolution record keyed by `escalation_id` (preserve the escalation's
  immutability), NOT a mutation of `guest_escalation`. Needs a mutation surface (CSRF) + an oracle pass. Medium.
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (per-wedding `recipient_ref`
  namespacing, OR masked-conflict semantics that doesn't corrupt the planner path). The most-cited open
  product-authz deferral. Medium; needs a real design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller.
- **Reply-from-the-inbox** — let the couple/planner answer an escalated guest directly (a console-initiated metered
  send). A new outbound-from-console capability; larger. Now motivated by this inbox.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has
  open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging provider
sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line, never across it or
simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The named
specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route adversarial reviews
through `general-purpose` agents carrying the persona lens (this run did, at design — both APPROVE-WITH-FIXES, no
exploit; all fixes applied). **CI/exit-code lesson:** never pipe `npm run build` to tail/grep when gating with `&&`
(the pipe masks the non-zero exit); run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
**Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by reachability).
**Schema change ⇒ `npm run gen:types`**; a NEW schema file additionally bumps the manifest count test (+ title prose)
+ the gen-script header — Phase 26 added the 19th schema (manifest now 19). **The guest responder's security boundary
is `projectGuestVisibleFacts`'s allow-list** — any new guest-visible fact is added THERE. **Web-form mutations are
CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable); a body value placed into a
request URL path MUST be `encodeURIComponent`'d. **The web UI's ONLY data path is `api.handle()`** (no repo/registry/
log dep on `ProductWebUi`) — a new read page DELEGATES through a JSON route, never holds the store. **Guest/manage
scope comes from the MINTED principal, never the request body**. **Inbound idempotency keys on `provider_message_ref`
per tenant**; the InboundReceiptLog records only refs we REPLIED to — escalations dedup in their OWN ref-keyed log.
