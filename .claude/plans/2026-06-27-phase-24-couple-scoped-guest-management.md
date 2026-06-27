# Phase 24 — Couple-scoped guest management (list + remove their own wedding's guests)

## Goal
Today guest management (`register` / `list` / `remove`) is **planner-only**: `GuestAuthorizer.authorizeManage`
returns `forbidden` for a couple, so a couple cannot see or manage even their OWN wedding's guests. That is the
Phase-21 tripwire. This rung gives a **couple** a resource-scoped slice of the surface: **list and remove the
guests of the one wedding they are bound to** — the guest analogue of `wedding_authorizer`'s couple-vs-planner
resource decision. `register` stays planner-only, on purpose (see the oracle below).

When this lands, a couple logging into the product surface sees their wedding's guest list (JSON + the themed
`?view=guests` page that already delegates to the JSON API) and can remove a guest, while a planner keeps the
unchanged whole-tenant view. **No new schema, no new contract, no new safety model** — it reuses the existing
`AccessDecision`/scope vocabulary, the tenant-scoped registry, and the Phase-21 CSRF seam wholesale.

## The load-bearing design decisions (settle in Step 0, carry forward)

- **`register` stays planner-only — the tenant-global `recipient_ref` collision oracle.** `recipient_ref` is the
  registry's **tenant-GLOBAL** partition key (one ref → one wedding across the whole tenant). If a couple could
  register, registering a ref already bound to ANOTHER wedding throws `PRODUCT.GUEST_ALREADY_REGISTERED` (409) —
  a cross-wedding existence oracle: the couple learns a ref is bound *somewhere* in the tenant, and a
  couple-scoped list (showing only their own wedding's guests) can't even cross-reference it away. Masking the
  409 to a success would corrupt the planner's own registration semantics. So couple-register is **deferred**
  and written up; this rung is **list + remove only** (both oracle-safe, below).

- **Couple `list` = their wedding's guests, by filtering the partition on `wedding_id`.** A guest binding is keyed
  by `recipient_ref` (not `wedding_id`), so "all guests of MY wedding" is a `wedding_id` filter over the tenant
  partition — unavoidable, and oracle-free: the filter runs in-process and the RESPONSE carries only the matching
  bindings, disclosing nothing about other weddings' guests. (This is *unlike* `wedding_authorizer.listScope`'s
  "never pull+filter" rule, which guards a *specific probed id*; here there is no probed id, just "give me mine".)
  A couple principal with `wedding_id === undefined` lists empty.

- **Couple `remove` is `wedding_id`-scoped and byte-identical on every miss.** A couple removing `recipient_ref R`
  deletes **only if** the stored binding's `wedding_id` equals their bound `wedding_id`; otherwise it is a no-op
  returning `removed:false`. The three non-success cases — `R` absent, `R` bound to another wedding, `R` in
  another tenant — ALL return the identical `{ removed:false }`, so a couple cannot distinguish "bound to another
  wedding" from "absent" (no cross-wedding existence oracle). A `removed:true` only ever names a guest the couple
  could already list, so it reveals nothing new. The read-then-delete both run `assertMintedContext` + liveness
  (inherited from the tenant-scoped repo). A couple with `wedding_id === undefined` always no-ops `false`.

- **Per-operation authorization replaces the single capability gate.** `dispatchGuests` no longer makes one
  `authorizeManage` decision before method dispatch. Instead: GET → scoped list (planner all / couple theirs),
  DELETE → scoped remove, POST → `authorizeRegister` (planner allow / couple `forbidden` → 403, checked BEFORE
  the body is parsed so a malformed couple body can't distinguish anything). An unknown method → 405 for all
  (the route exists tenant-independently; 405 is not a tenant oracle).

- **The browser `?view=guests` page lights up for couples for free; the add-guest form stays a capability
  affordance.** `#guestsPage` only delegates to `api.handle()`, so once GET `/guests` returns 200 for a couple
  the page renders their scoped list with no web-layer change. The add-guest (register) form has no role signal
  to hide it (the list contract carries none), so it stays shown to all and a couple's submit takes the honest
  themed **403 → re-render with the generic notice** — identical to Phase 23's create-is-a-capability-affordance
  decision. Remove works for couples through the existing CSRF-gated `/guests/remove` form unchanged.

## Steps

- [x] **Step 0 — Design review.** architect + doddy (general-purpose lenses) both **APPROVE-WITH-FIXES** — all
  findings are wiring/test/doc, no architecture change. Folded in: **(MF-a)** rename `scope`→**`manageScope`**
  (keeps the `…Scope` parallel with `listScope`, signals it scopes the whole manage surface not just list).
  **(MF-b)** `removeForWedding` ALWAYS runs `#repo.read` first (which runs `assertMintedContext`+liveness on
  every path) THEN conditionally `#repo.delete` — so the four miss cases (absent / sibling-wedding / foreign-
  tenant / `undefined` wedding_id) are byte-identical including the suspended-tenant liveness throw; no pre-read
  `undefined` early-return. **(MF-c)** the `wedding_id` passed to `removeForWedding` is `manageScope.wedding_id`
  from the authorizer, NEVER the body (body carries ONLY `recipient_ref`, the delete key); `handleGuestList`/
  `handleGuestRemove` take `principal`. **(MF-d)** `authorizeRegister` is the LITERAL first statement of
  `handleGuestRegister`, before `parseObjectBody` and before the referential-integrity 404 — so a couple POST
  (even a duplicate ref) → 403, never reaching the 409 that would re-leak the deferred oracle. **(MF-e)** the
  `undefined`-wedding_id collapse to `[]`/`false` lives ONLY inside the registry methods (handler is a pure
  two-arm `kind` branch, NOT re-checking undefined — diverges deliberately from `handleList`, documented on
  `GuestScope`). **(MF-f)** fix four stale "planner-only" comments (`guest_authorizer.ts` header,
  `guest_registry.ts` header, `product_web_ui.ts:152` + `#guestsPage` docstring, `product_api.ts` dispatchGuests
  block). Keep the `'wedding'` scope-arm name (`'single'` would be wrong — a wedding has many guests). Confirmed:
  register-deferral oracle real; couple list/remove leak nothing; no method/route oracle; no new schema.

- [x] **Step 1 — Authorizer + registry (`guest_authorizer.ts`, `guest_registry.ts`).** Replace
  `GuestAuthorizer.authorizeManage` with `authorizeRegister(principal): AccessDecision` (planner allow / couple
  forbidden) and `scope(principal): GuestScope` where `GuestScope = { kind:'all' } | { kind:'wedding'; wedding_id:
  string | undefined }` (mirror `wedding_authorizer`'s `ListScope`). Add to `GuestRegistry`:
  `listForWedding(context, wedding_id): readonly GuestBinding[]` (filter the partition; `undefined` → `[]`) and
  `removeForWedding(context, recipient_ref, wedding_id): boolean` (read binding; delete iff
  `binding?.wedding_id === wedding_id`, else `false`; `undefined` wedding_id → `false`). Keep `list`/`remove` for
  the planner path. Update the canonical doc comments (the old "no couple-scoped decision here" note is now
  wrong). Unit tests: `tests/auth/guest_authorizer.test.ts` (new) + registry scope cases. Green.

- [x] **Step 2 — Handler wiring (`product_api.ts`).** Restructure `dispatchGuests`: drop the top-level
  `authorizeManage` gate; GET → `handleGuestList(context, principal, deps)` (branch on `scope`: all → `registry
  .list`, wedding → `registry.listForWedding`); DELETE → `handleGuestRemove(context, principal, req, deps)`
  (branch on `scope`: all → `registry.remove`, wedding → `registry.removeForWedding`); POST →
  `handleGuestRegister` with `authorizeRegister` as its FIRST line (couple → `throw forbidden()` before body
  parse). Keep the register referential-integrity 404 unchanged. Green.

- [x] **Step 3 — JSON keystone/flow tests (`tests/http/`).** Extend `guest_api.test.ts` + the keystone: a couple
  lists ONLY their wedding's guests (a sibling wedding's guest never appears); a couple removes their own guest
  (true) and the binding is gone; a couple removing a sibling-wedding ref and an absent ref are **byte-identical**
  `{removed:false}` with the sibling binding **untouched**; a couple POST register → 403 (no binding created, and
  a duplicate-ref couple register can't be distinguished from a fresh one — the 403 precedes the 409 path); a
  planner's whole-tenant list/remove are unchanged. Green.

- [ ] **Step 4 — Browser surface + e2e + docs.** Add `tests/web/guest_web.test.ts` couple cases: a couple opens
  `?view=guests` and sees their scoped list (200, not a 404/403); a couple removes a guest via the CSRF-gated
  form (303 → gone); a couple's add-guest submit ⇒ themed 403 re-render + no mutation (forged CSRF still masks
  403 first). A compose-level e2e: a couple logs into the HTML front door, sees their wedding's seeded guest, and
  removes it. Write **ADR 0024**, memory `couple-scoped-guest-management.md` (+ index in `MEMORY.md`), update
  `.claude/handoff.local.md`. Final `npm run build && npm test && npm run lint` green; commit per step.

## Out of scope (deferred, with reason)
- **Couple-scoped guest REGISTER** — the tenant-global `recipient_ref` 409 is a cross-wedding existence oracle; a
  clean design (per-wedding ref namespacing, or a masked-conflict semantics that doesn't corrupt the planner
  path) is its own rung. Written up in the ADR + memory.
- **Hiding the add-guest form from couples by role** — needs a role signal the guests-list contract doesn't carry
  (same limitation Phase 23 noted for wedding-create); the capability 403 is the honest boundary for now.
- **Clear-to-absent logistics sentinel** — unrelated product-completeness rung, still open.
