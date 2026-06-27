# Handoff

## Where things stand — Phase 25 (clear-to-absent logistics sentinel) is COMPLETE ✅
`.claude/plans/2026-06-27-phase-25-clear-to-absent-logistics-sentinel.md` is **complete — Step 0 design review +
Steps 1–4 ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`;
Phases 3–25 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**798 tests**, up from 793 at the start of this run).

This rung closes the **most-cited Phase-23 deferral**: a planner can now **clear** one of the four optional
guest-visible logistics fields (`ceremony_time`/`venue_name`/`parking_info`/`dress_code`) back to **absent**,
from the browser edit form and the JSON `PUT`. ADR 0025, memory [[clear-to-absent-logistics-sentinel]]. doddy
APPROVE + architect APPROVE-WITH-FIXES on the design (all fixes applied in the build). No new schema/route/authz,
one safety model reused.

## What changed this phase
- **`wedding_repository.ts`** — exported ONE `WEDDING_LOGISTICS_FIELDS` const (+ `WeddingLogisticsField` type)
  so the API key set and the web body builder share a single source of truth (killed two hand-maintained copies).
- **`product_api.ts`** — `handleUpdate`'s `patchOptional` is now THREE-WAY: key absent ⇒ PRESERVE; key `''` ⇒
  CLEAR (returns `undefined` → the EXISTING `...(x===undefined?{}:{x})` spread drops it, ONE absent-key
  mechanism); non-empty ⇒ `requireString` set. RAW + strict `=== ''` match (a non-string falls to
  `requireString` ⇒ 400). `handleCreate` untouched + a corrected comment (empty optional on POST is malformed).
- **`product_web_ui.ts`** — `weddingBodyFromForm(form, { clearable })`: update passes `clearable:true` (sends the
  four optionals even when empty so `''` reaches the PUT sentinel); create omits empties (default). `clearable`
  gates ONLY the four optionals (required name/date/status stay always-sent). Imports the shared const.
- **`pages.ts`** — the edit card's note (in `renderDetail`, NOT the shared `weddingFormFields`) now says blanking
  an optional field clears it.
- **Tests** — `product_api.test.ts`: PUT clears each field via `''` + persists; non-string (`['']`/`0`/`null`) ⇒
  400; POST `''` still 400 (create contract locked). `wedding_web.test.ts`: edit-form blank CLEARS (detail no
  longer renders it); resend-prefilled PRESERVES; create-blank is just unset (303). `compose.test.ts`: the
  dress-code e2e gained a third leg — clear via the browser ⇒ the SAME guest question escalates again ⇒ meter
  stays at 1 (clear reaches the responder end-to-end).

## The load-bearing insight (carry forward) — see [[clear-to-absent-logistics-sentinel]] for the full set
- **`''` is the clear sentinel, meaningful ONLY on the optional fields of `PUT`.** Native HTML-form empty; the
  fields' `minLength:1`/pattern already reject `''` so it collides with nothing. CREATE is byte-for-byte
  unchanged (POST `''` still 400 — nothing to clear on a new resource; `requireString`/`optionalString`
  untouched). The asymmetry (empty=400 POST vs empty=clear PUT) is per-operation-correct and SAFE (both
  observable only to the already-authz'd planner on their own tenant — not a confusion oracle).
- **The clear reuses the existing absent-key spread** (`patchOptional` returns `undefined`) — ONE codepath, not a
  second clear write. RAW + strict match keeps hostile bodies on the 400 path (can't persist an invalid record;
  the full record is re-validated on every update).
- **Reduce-only disclosure (doddy):** clearing a guest-visible fact flips the responder `answered`→`escalated`
  (no send, no meter) — strictly LESS disclosure; no field's absence reveals MORE; `escalated`/`refused` are both
  wire-silent (uniform 202). The clear can only move disclosure in the safe direction.
- **One builder, one const.** `weddingBodyFromForm(form,{clearable})` — the flag is the single divergence axis,
  gating ONLY the optionals. `WEDDING_LOGISTICS_FIELDS` is the shared field set (a deeper `logistics`
  sub-aggregate is premature at four flat fields with no cross-field invariant).

## Next action — your call. Pick the next high-value lever (ranked)
- **A couple-REGISTER design rung** — resolve the deferred oracle properly (per-wedding `recipient_ref`
  namespacing, OR a masked-conflict semantics that doesn't corrupt the planner path). Lets couples add their own
  guests. Medium; needs a real design pass on the tenant-global-key collision (the Phase-24 oracle). The most
  cited open product-authz deferral now.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean follow-up Phase 20 deferred; tidies the two-cents-tables seam.
- **A "decline vs route-to-couple" escalation/notification model** — gives `escalated` (and the now-distinct
  `refused`) real downstream behavior (notify the couple when a guest asks an unanswerable logistics question).
  Larger; now MORE motivated since clearing a field deliberately produces an escalation a couple might want to see.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has
  open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging provider
sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line, never across it or
simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The named
specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route adversarial reviews
through `general-purpose` agents carrying the persona lens (this run did, at design — doddy APPROVE + architect
APPROVE-WITH-FIXES, all fixes applied in the build). **CI/exit-code lesson:** never pipe `npm run build` to tail/grep
when gating with `&&` (the pipe masks the non-zero exit); run build standalone, check `$?`. `npm run build` runs from
REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by
reachability). **Schema change ⇒ `npm run gen:types`**; a NEW schema file additionally bumps the manifest count test +
the gen-script header — Phase 25 added NO schema (manifest stays 18). **The guest responder's security boundary is
`projectGuestVisibleFacts`'s allow-list** — any new guest-visible fact is added THERE. **Web-form mutations are
CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable); a body value placed into a
request URL path MUST be `encodeURIComponent`'d. **Guest/manage scope comes from the MINTED principal, never the
request body**. **Clear-to-absent on PUT is the `''` sentinel on the optional logistics fields ONLY; CREATE rejects an
optional `''`** (the Phase-25 lesson).
