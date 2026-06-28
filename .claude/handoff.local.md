# Handoff

## Where things stand — Phase 27 (escalation resolution / dismissal) is COMPLETE ✅
`.claude/plans/2026-06-27-phase-27-escalation-resolution.md` is **complete — Step 0 design review +
Steps 1–3 ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`;
Phases 3–27 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**844 tests**, up from 820 at the start of this run).

This rung makes the Phase-26 escalation inbox **clearable**: the couple (their wedding) / planner (whole tenant)
mark a guest escalation **handled** — `resolved` (dealt with, typically the missing fact filled) or `dismissed`
(not actionable: spam/irrelevant/duplicate) — moving it from the **Open** section to **Handled**. The inbox's
FIRST mutation. The escalation record stays **immutable**: handling is a SEPARATE append-only resolution record
keyed by `escalation_id` (ADR 0026 F6, pinned in advance). ADR 0027, memory [[escalation-resolution]].
doddy + architect APPROVE-WITH-FIXES on the design (**no exploit found**); all fixes applied in the build.

## What changed this phase
- **20th schema** `product/schemas/escalation_resolution_schema.json` (`resolution_id`/`tenant_id`/`escalation_id`/
  `wedding_id`/`status` enum/`resolved_by` enum/`resolved_at`; `resolved_at` = `minLength:1`, **no format** —
  matches `received_at` so the real `clock.now()` can't fail validation) + manifest/count-test/gen-script
  bookkeeping (19→20) + `gen:types` emits `EscalationResolution`; barrel-exported from shared + product.
- **`escalation_resolution_log.ts`** (new) — `EscalationResolutionLog`: a thin face over
  `TenantScopedRepository<EscalationResolution>` **keyed by `escalation_id`**, ctor `(liveness, ids, clock)`.
  `resolve` (read-first-put-if-absent → FIRST-WRITER-WINS, clock-stamps `resolved_at`) / `list` (planner) /
  `listForWedding` (couple). Plus **`EscalationLog.getByEscalationId`** (a tenant-scoped `list().find`) for the
  couple-scope lookup.
- **`product_api.ts`** — `dispatchEscalations` now GET→`handleEscalationList` / POST→`handleEscalationResolve` /
  else 405. `handleEscalationList` returns `{escalations, resolutions}` (both scoped by the SAME `manageScope`
  branch). `handleEscalationResolve` with PINNED statement order + the shared frozen `RESP_RESOLVE_MISS`.
  `EscalationHandlerDeps` gains `resolutions`.
- **`product_web_ui.ts` + `pages.ts`** — `#escalationsPage` now issues CSRF + reads both arrays
  (`readResolutions`); new 4-seg `POST /t/:slug/escalations/resolve` form route + `#escalationResolve` (slug-mask
  → 404 before CSRF; forged → 403 no mutation). `renderEscalations(theme, slug, escalations, resolutions, csrf)`
  splits **Open** (Resolve/Dismiss CSRF forms) vs **Handled** (status badge + `resolved_by`).
- **`compose.ts`** — ONE `EscalationResolutionLog` wired into the `escalations` deps (read + resolve); exposed on
  `ComposedSurface`.
- **Tests** — `escalation_resolution_log.test.ts` (resolve/first-writer-wins/scope/isolation/liveness, real
  clock value); `escalation_log.test.ts` +1 (`getByEscalationId` hit/miss/foreign-tenant); `escalation_resolve_api.test.ts`
  (planner-any / couple-theirs / **F1 byte-equality of absent vs foreign-wedding miss** / **F2 foreign probe
  writes nothing** / smuggle-inert / idempotency / bad-status-400 / **F4 two-array scope** / tenant isolation);
  `escalation_api.test.ts` (405/401 verbs updated for the new POST); `pages.test.ts` +2 (Open/Handled split +
  CSRF forms; XSS still escaped); `escalation_web.test.ts` (new — forged-CSRF 403 no-mutation / valid resolve 303
  / unknown-slug 404 before CSRF / JSON not CSRF-reachable); `compose.test.ts` +1 e2e (resolve via the browser
  form → Handled → later dismiss is a no-op, status stays `resolved`).

## The load-bearing insight (carry forward) — see [[escalation-resolution]] for the full set
- **The escalation is IMMUTABLE; the resolution is a SEPARATE append-only record keyed by `escalation_id`**
  (first-writer-wins). Re-opening / changing a recorded status is deferred (a mutation-of-a-mutation).
- **The resolve mutation is oracle-free by ONE shared frozen `RESP_RESOLVE_MISS`** — a couple's absent-id and
  foreign-wedding-id misses are byte-identical by CONSTRUCTION (not test-hoped), and the couple `wedding_id`
  match gates the WRITE (a foreign probe records nothing). Statement order is pinned (status enum 400 fires
  independent of existence).
- **Trusted-state provenance:** `wedding_id` copied from the live escalation read in the SAME request,
  `resolved_by` from `principal.role`, `resolved_at` clock-stamped in the log (its ctor takes the clock — unlike
  `received_at`, which the messaging PORT stamps). A smuggled body field is inert.
- **CSRF at the web layer only; the JSON mutation API is Bearer-only / not CSRF-reachable.** The 4-seg
  `escalations/resolve` web route ≠ the 3-seg JSON route. The read returns two arrays scoped identically.

## Next action — your call. Pick the next high-value lever (ranked)
- **Reply-from-the-inbox** — let the couple/planner answer an escalated guest directly (a console-initiated
  metered send). Now DOUBLY motivated (resolve-by-replying). A new outbound-from-console capability; larger —
  needs a mutation surface (CSRF), the meter wired from the console path, and an oracle pass on the recipient.
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (per-wedding `recipient_ref`
  namespacing, OR masked-conflict semantics that doesn't corrupt the planner path). The most-cited open
  product-authz deferral. Medium; needs a real design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller.
- **Auto-resolve on fill** — automatically mark an escalation resolved when the couple fills the matching fact.
  Needs an escalation→field link the record lacks (a `topic`/field tag); deferred with the `topic` field.
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
+ the gen-script header — Phase 27 added the 20th schema (manifest now 20). **The guest responder's security boundary
is `projectGuestVisibleFacts`'s allow-list** — any new guest-visible fact is added THERE. **Web-form mutations are
CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable); a body value placed into a
request URL path MUST be `encodeURIComponent`'d. **The web UI's ONLY data path is `api.handle()`** (no repo/registry/
log dep on `ProductWebUi`) — a new read page DELEGATES through a JSON route, never holds the store. **Guest/manage
scope comes from the MINTED principal, never the request body**. **Inbound idempotency keys on `provider_message_ref`
per tenant**; escalations dedup in their OWN ref-keyed log; **escalation RESOLUTIONS dedup in their OWN
escalation_id-keyed log (first-writer-wins)**. **A scoped mutation that must be oracle-free returns ONE shared frozen
miss constant on every miss branch** (so byte-identity is structural, not test-enforced) — the Phase-27 `RESP_RESOLVE_MISS`.
