# Handoff

## Where things stand — Phase 24 (couple-scoped guest management) is COMPLETE ✅
`.claude/plans/2026-06-27-phase-24-couple-scoped-guest-management.md` is **complete — Step 0 design review +
Steps 1–4 ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`;
Phases 3–24 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**794 tests**, up from 781 at the start of this run).

This rung resolves the **Phase-21 tripwire**: a **couple** can now **list + remove the guests of the one
wedding they are bound to** (the guest analogue of `wedding_authorizer`'s couple-vs-planner resource decision),
through both the JSON API and the themed `?view=guests` page. `register` stays planner-only (the oracle, below).
ADR 0024, memory [[couple-scoped-guest-management]]. doddy + architect APPROVE-WITH-FIXES on the design (all
must-fixes applied in the build). No new schema/contract, one safety model reused.

## What changed this phase
- **`guest_authorizer.ts`** — split the single planner-only `authorizeManage` into `authorizeRegister(principal)`
  (planner allow / couple forbidden) + `manageScope(principal): GuestScope` (`{kind:'all'}` planner /
  `{kind:'wedding', wedding_id}` couple, from `principal.wedding_id` ONLY). New `GuestScope` type. The two
  authorizers share only `AccessDecision`, NOT a scope type.
- **`guest_registry.ts`** — paired scope-agnostic methods (mirrors `weddings.list`/`get`): `listForWedding`
  (partition filter; `undefined`→`[]`) + `removeForWedding` (reads FIRST so liveness fires on every path, then
  deletes iff the stored `wedding_id` matches; every miss byte-identical `false`).
- **`product_api.ts`** — `dispatchGuests` restructured to per-method authz: GET → `handleGuestList` (scope
  branch), DELETE → `handleGuestRemove` (scope branch, `wedding_id` from `manageScope` NEVER the body), POST →
  `handleGuestRegister` with `authorizeRegister` as the LITERAL first line (before body parse / 404 / 409).
- **`product_web_ui.ts`** — doc only: the `?view=guests` page + `#guestsPage` comments updated (couples now get
  200, not 403; add-guest form is a capability affordance). No web-layer code change — the page lights up for
  couples via delegation.
- **Tests** — new `tests/auth/guest_authorizer.test.ts`; registry scope + suspended-tenant-liveness cases;
  couple list/remove + register-403 + byte-identical-miss in `tests/http/guest_api.test.ts`; couple browser
  cases in `tests/web/guest_web.test.ts`; one compose e2e (`tests/runtime/compose.test.ts`).

## The load-bearing insight (carry forward) — see [[couple-scoped-guest-management]] for the full set
- **`register` stays planner-only — the tenant-global `recipient_ref` 409 oracle.** `recipient_ref` is the
  registry's tenant-GLOBAL partition key; a couple-register of a ref already bound to ANOTHER wedding would
  409-leak cross-wedding existence (a couple-scoped list can't cross-reference it away). So register is a
  capability a couple LACKS; the 403 is the LITERAL first statement so even a duplicate-ref/junk-body couple
  POST is a constant 403, never reaching the 409.
- **Couple `remove` is byte-identical on EVERY miss — a REGISTRY guarantee.** `removeForWedding` ALWAYS reads
  first (liveness fires on every path → a suspended tenant throws on a miss exactly as on a hit, no
  error-vs-silent-false distinguisher), then deletes iff `wedding_id` matches. The `wedding_id` arg is
  `manageScope.wedding_id`, NEVER the body — a smuggled `wedding_id` can't widen reach. 4 miss cases (absent /
  sibling-wedding / foreign-tenant / `undefined`) all `{removed:false}`.
- **Couple `list` = partition FILTER, oracle-free** (no probed id — deliberately unlike `wedding_authorizer`'s
  "never pull+filter"). A couple principal ALWAYS carries a `wedding_id` (`SessionStore.login` enforces it), so
  the `undefined` arm is defensive-only / unreachable via a real principal.
- **The browser add-guest form is a capability affordance** (couple submit → delegated planner-only 403 →
  re-render; forged CSRF still masks 403 before the forward) — same call Phase 23 made for wedding-create.

## Next action — your call. Pick the next high-value lever (ranked)
- **★ A clear-to-absent update sentinel** for logistics fields — the HTML edit form (Phase 23) still can't blank
  a field; a planner who sets a wrong dress code can't clear it from the browser. Small, product-completeness,
  now the most-cited open deferral. **Recommended.**
- **A couple-REGISTER design rung** — resolve the deferred oracle properly (per-wedding `recipient_ref`
  namespacing, OR a masked-conflict semantics that doesn't corrupt the planner path). Lets couples add their own
  guests. Medium; needs a real design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean follow-up Phase 20 deferred; tidies the two-cents-tables seam.
- **A "decline vs route-to-couple" escalation/notification model** — gives `escalated` (and the now-distinct
  `refused`) real downstream behavior (notify the couple when a guest asks an unanswerable logistics question).
  Larger; now MORE motivated since a couple can be a real recipient of such a notification.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging provider
sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line, never across it or
simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The named
specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route adversarial reviews
through `general-purpose` agents carrying the persona lens (this run did, at design — doddy + architect
APPROVE-WITH-FIXES, all must-fixes applied in the build). **CI/exit-code lesson:** never pipe `npm run build` to
tail/grep when gating with `&&` (the pipe masks the non-zero exit); run build standalone, check `$?`. `npm run build`
runs from REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by
reachability). **Schema change ⇒ `npm run gen:types`**; a NEW schema file additionally bumps the manifest count test +
the gen-script header — Phase 24 added NO schema (manifest stays 18). **The guest responder's security boundary is
`projectGuestVisibleFacts`'s allow-list** — any new guest-visible fact is added THERE. **Web-form mutations are
CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable); a body value placed into a
request URL path MUST be `encodeURIComponent`'d (the wedding_id-in-PUT lesson). **Guest scope comes from the MINTED
principal, never the request body** (the couple-remove `wedding_id` lesson); a couple login ALWAYS carries a wedding_id.
