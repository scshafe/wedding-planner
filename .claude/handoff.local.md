# Handoff

## Where things stand — Phase 23 (HTML wedding create & edit forms) is COMPLETE ✅
`.claude/plans/2026-06-27-phase-23-html-wedding-forms.md` is **complete — Step 0 design review + Steps 1–4
ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3–23 build
on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**781 tests**, up from 762 at the start of this run).

This rung makes the customer-facing surface **operable from the browser for the core wedding aggregate**: a
planner creates a wedding and a planner/couple edits one — including the Phase-22 logistics fields — through
themed HTML forms, no JSON required. It is the wedding-mutation analogue of the Phase-21 guest forms
([[planner-guest-management-and-csrf]]), reusing that CSRF seam wholesale. ADR 0023, memory
[[html-wedding-create-edit-forms]]. doddy + architect APPROVE-WITH-FIXES on the design (all must-fixes applied
in the build). The Phase-22 demo loop now CLOSES in the browser (e2e proves it).

## What changed this phase
- **`pages.ts`** — a shared `weddingFormFields` helper (required name/date/status `<select>` + the four optional
  logistics fields, all escaped) + `statusOptions`. `renderConsole` gained an `invalid` flag + an inline CREATE
  form; `renderDetail` gained a `csrfToken` + `invalid` flag + an inline prefilled EDIT form.
- **`product_web_ui.ts`** — two new web routes `POST /t/:slug/weddings/{create,update}` (4-seg, distinct from the
  JSON 4-seg `:id` route). `#weddingCreate` / `#weddingUpdate` verify CSRF before the cookie→Bearer translation;
  `#console` refactored into `#weddingList` + `#detail` (both take an `invalid` re-render flag); a pure
  `weddingBodyFromForm` builds the request body (optional field included only when non-empty).
- **Tests** — `tests/web/wedding_web.test.ts` (15 web-flow tests) + 5 new `pages.test.ts` assertions + 1 compose
  e2e (`compose.test.ts`).

## The load-bearing insight (carry forward) — see [[html-wedding-create-edit-forms]] for the full set
- **The body `wedding_id` MUST be `encodeURIComponent`'d into the PUT URL** (MF-1). Unencoded, `../sessions` or a
  `/`-bearing value re-segments onto a sibling route; encoded → one opaque segment → masked 404. Identity stays
  URL+context-stamped (a body-smuggled id is inert — Phase 13 invariant).
- **Empty/collapsing/non-owned ids all mask to one byte-identical `GENERIC_404`** (MF-2): the update failure ALWAYS
  re-renders the detail page, and the detail re-fetch of an empty/non-owned id itself masks — no raw 405/400 oracle.
- **Create is a CAPABILITY affordance** (form shown to all; couple submit → JSON 403 → themed Forbidden — no
  resource oracle). Hiding it from couples needs a role signal the weddings-list contract doesn't carry.
- **The detail page issues CSRF ONLY inside the api `200` block** (mirrors the list-branch invariant: csrf-absent
  ⇒ ERROR_500, theme-absent ⇒ GENERIC_404); minted only on the own-wedding path, so no oracle for a couple probing
  another id.
- **Omit = preserve-on-update / unset-on-create.** Blanking a logistics field to REMOVE it is NOT expressible from
  the browser yet — a bounded limitation (the deferred clear-to-absent sentinel), noted in the form copy.

## Next action — your call. Pick the next high-value lever (ranked)
- **★ Couples managing their own wedding's guests** — the Phase-21 tripwire; extend `GuestAuthorizer` to a
  couple-scoped resource decision (list + remove their own wedding's guests). **DESIGN NOTE discovered this run:**
  couple-REGISTER has a real oracle — `recipient_ref` is the tenant-GLOBAL partition key, so a couple registering a
  ref already bound to ANOTHER wedding leaks via the 409 (and the list cross-reference defeats a masked 409). The
  clean rung is couple-scoped **list + remove** (both oracle-safe: remove reads the binding and no-ops false on a
  non-owned/absent ref — byte-identical), with couple-register deferred + the oracle written up. **Recommended.**
- **A clear-to-absent update sentinel** for logistics fields — now MORE motivated (the HTML edit form can't blank a
  field; a planner who sets a wrong dress code can't clear it from the browser). Small, product-completeness.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`) —
  the clean follow-up Phase 20 deferred; tidies the two-cents-tables seam.
- **A "decline vs route-to-couple" escalation/notification model** — gives `escalated` (and the now-distinct
  `refused`) real downstream behavior (notify the couple when a guest asks an unanswerable logistics question). Larger.

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
the gen-script header (modifying an existing schema does NOT) — Phase 23 added NO schema (manifest stays 18). **The
guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list** — any new guest-visible fact is added
THERE. **Web-form mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable); a
body value placed into a request URL path MUST be `encodeURIComponent`'d (the wedding_id-in-PUT lesson).
