# Phase 25 — Clear-to-absent sentinel for logistics fields

## Goal
The Phase-23 HTML edit form can SET and PRESERVE the optional logistics fields (`ceremony_time` /
`venue_name` / `parking_info` / `dress_code`) but cannot **clear** one: a planner who sets a wrong dress
code cannot blank it from the browser (the web body builder OMITS an empty input, and on the JSON `PUT`
an omitted optional field PRESERVES the stored value). Give the planner a way to **clear a logistics
field back to absent** through the browser edit form and the JSON API — the top-ranked, most-cited open
product deferral.

This is a small **product-completeness** rung. **No new schema, no new route, no new safety machinery,
no authz change.** The fields stay optional in the contract; clearing produces a record with the key
absent (the existing conditional-spread already omits an `undefined` field). The whole change is the
*interpretation of an empty value* on the update path, plus surfacing the affordance in the form.

## The load-bearing design decisions (settle in Step 0, carry forward)
- **The wire sentinel for "clear" is the EMPTY STRING, and it is meaningful ONLY on the optional logistics
  fields of the UPDATE (`PUT`) path.** An empty `""` for one of the four logistics fields on `PUT` means
  "remove this field." This is the natural HTML-form representation (a cleared `<input>` submits `key=`),
  needs no new wire concept, and the four fields already reject `""` at the contract (`minLength`/pattern),
  so `""` carried no prior valid meaning to collide with.
- **Clear-to-absent is fundamentally an UPDATE concept; the CREATE path is unchanged byte-for-byte.** On
  `POST` there is no existing value to clear, so the create contract stays exactly as today: a direct JSON
  create sending `dress_code: ""` still 400s (honest — omit it instead), and the web create form keeps
  OMITTING empty optionals. The asymmetry is correct per operation, not an inconsistency: POST sets initial
  values (an empty optional is malformed), PUT patches (an empty optional removes). This keeps the
  create-path risk at zero.
- **Three-way update semantics on each optional field** (the only handler change): key **absent** ⇒ PRESERVE
  the stored value (unchanged — a direct JSON caller omitting a key still preserves); key present as **`""`**
  ⇒ CLEAR to absent; key present as a **non-empty string** ⇒ validate + set. Strict equality on `""` (a
  non-string like `0`/`null` is not `""` and not absent ⇒ falls to the existing `requireString` 400).
- **The web update form ALWAYS sends the four optional fields (even when empty); the create form keeps
  omitting them.** So from the browser, "clear" (empty ⇒ removed) and "preserve" (prefilled value resent)
  and "set" (new value) all work, while create is untouched. The shared `weddingBodyFromForm` gains a
  `clearable` flag (update passes `true`, create passes nothing/`false`).
- **No new oracle / no widened reach (doddy).** The change operates ONLY on the planner's already-authorized
  own wedding — ownership is decided BEFORE the body is parsed (unchanged), identity (`wedding_id` from
  route, `tenant_id` from context) is still stamped LAST, so a body `dress_code: ""` cannot re-target.
  Clearing can only REMOVE a guest-visible logistics fact ⇒ strictly *reduces* disclosure (the safe
  direction): a cleared field flips the guest responder from `answered` to `escalated` (no send, no meter),
  exactly the Phase-22 unset behavior. No cross-tenant / cross-wedding path, no status/existence signal.

## Steps

- [x] **Step 0 — Design review.** doddy **APPROVE** (no oracle; reduce-only disclosure holds; three-way
  rule well-defined for hostile bodies — `[""]`/`0`/`null`/dup-keys all fall to `requireString` 400 or
  collapse to the absent-key spread; one build guardrail: `clearable` must gate ONLY the four optionals,
  the required-field branch must stay `requireString`-on-empty→400). architect **APPROVE-WITH-FIXES**: (1)
  branch on `""` BEFORE `requireString` returning `undefined` so it flows through the EXISTING
  `...(x===undefined?{}:{x})` spread (one absent-key mechanism, no second codepath); (2) match raw
  `body[key]===''` only in `handleUpdate`, never touch `requireString`/`optionalString` (POST stays
  byte-for-byte); (3) replace the now-false "no clear-to-absent sentinel" comment + add a one-liner on
  `handleCreate` (empty optional rejected — omit to leave unset); (4) one `weddingBodyFromForm(form,{clearable})`
  builder; (5) the "blank to clear" note lives in `renderDetail`'s edit wrapper, NOT the shared
  `weddingFormFields`; (6) cheap hedge — export ONE `WEDDING_LOGISTICS_FIELDS` const referenced by both
  the web builder AND the `patchOptional` key type (the two hand-maintained copies will otherwise drift);
  do NOT extract a sub-aggregate yet (premature at four flat fields). All adopted below.

- [ ] **Step 1 — JSON API update handler (`product_api.ts`).** Change `patchOptional` in `handleUpdate`
  to the three-way rule: `body[key] === undefined` ⇒ `existing[key]` (preserve); `body[key] === ''` ⇒
  `undefined` (clear); else `requireString(body, key)` (set). Leave `handleCreate` untouched. Update the
  inline doc (replace the "no clear-to-absent sentinel this rung" note with the new semantics). New
  `tests/http/wedding_api.test.ts` cases: PUT `dress_code: ""` clears it (200, key absent in result + on
  re-read); PUT omitting it still PRESERVES; PUT non-empty still SETS; PUT clearing each of the other
  three; PUT `dress_code: 0`/`null` still 400 (non-string); **POST `dress_code: ""` still 400 (create
  contract locked)**. `npm run build && npm test && npm run lint` green.

- [ ] **Step 2 — Web form (`product_web_ui.ts` + `pages.ts`).** Give `weddingBodyFromForm` a `clearable`
  flag: when true, include the four optional fields even when empty (`body[key] = value` unconditionally);
  when false/absent (create), keep omitting empties. `#weddingUpdate` calls it with `clearable: true`;
  `#weddingCreate` unchanged. Surface the affordance on the EDIT form only: a small note (e.g. "blank to
  clear") near the logistics inputs in `renderDetail`'s edit card (not the shared input set, which create
  reuses) — escaped static text, no new field. Update `pages.test.ts` for the note; update doc comments on
  `weddingBodyFromForm` / `#weddingUpdate`. Green.

- [ ] **Step 3 — Web-flow + e2e tests.** `tests/web/wedding_web.test.ts`: a planner sets `dress_code` via
  the edit form, then submits the form with `dress_code` blank ⇒ the detail page no longer shows the dress
  code (cleared); a blank optional on the CREATE form is still just unset (regression); preserve-on-resend
  still holds. Extend the compose e2e (`tests/runtime/compose.test.ts`, the existing
  escalated→answered dress-code test) with a third leg: clear `dress_code` via the browser form ⇒ the SAME
  guest question goes back to `escalated` (no new meter increment) — proving the clear reaches the guest
  responder end-to-end. Green.

- [ ] **Step 4 — Docs + memory + handoff.** Write **ADR 0025**, a memory file
  `clear-to-absent-logistics-sentinel.md` (+ index it in `MEMORY.md`, linking
  [[html-wedding-create-edit-forms]] / [[richer-guest-visible-facts]]), and update
  `.claude/handoff.local.md` (where we are, next action, fresh context). Final
  `npm run build && npm test && npm run lint` green; commit per step on `build/phase-3-generalize-search`.

## Out of scope (deferred, with reason)
- **Couple-REGISTER design rung** (per-wedding `recipient_ref` namespacing) — the tenant-global-key
  collision oracle from Phase 24; its own design rung.
- **Unify `price_book.ts` onto the shared cost basis** — a separate Phase-20 follow-up.
- **Clearing on the JSON CREATE path** — deliberately NOT a thing (nothing to clear on create); create
  stays byte-for-byte.
- **A typed PATCH verb / explicit `_clear` field list** — heavier wire concept than this rung needs; the
  empty-string sentinel is sufficient and form-native. Revisit only if a future field's empty string
  becomes a legitimate value.
