---
name: couple-scoped-guest-management
description: Phase 24 — a couple can list+remove THEIR wedding's guests (register stays planner-only — the tenant-global recipient_ref 409 oracle); the GuestAuthorizer capability/scope split + the byte-identical-miss registry guarantee
metadata:
  type: project
---

Phase 24 (the product-surface authz rung resolving the Phase-21 tripwire of
[[planner-guest-management-and-csrf]]): a **couple** can now **list + remove the guests of the one wedding
they are bound to** — the guest analogue of `wedding_authorizer`'s couple-vs-planner resource decision.
`register` stays planner-only. No new schema/contract, one safety model reused.

**Why register stays planner-only (the load-bearing oracle).** `recipient_ref` is the registry's
**tenant-GLOBAL** partition key (one ref → one wedding across the whole tenant). A couple registering a ref
already bound to ANOTHER wedding would throw `PRODUCT.GUEST_ALREADY_REGISTERED` (409) — a cross-wedding
existence oracle a couple-scoped list (own wedding only) can't cross-reference away; masking it to a success
would corrupt the planner's own registration semantics. So `register` is a **capability a couple lacks**
(`authorizeRegister` → 403). A clean couple-register (per-wedding ref namespacing, or masked-conflict that
doesn't corrupt the planner path) is a future rung. **The 403 is the LITERAL first statement of
`handleGuestRegister`** — before body parse / the referential-integrity 404 / the 409 — so a couple POST (even
a duplicate ref, even a junk body) is a constant 403, never reaching the 409.

**The shape.** `GuestAuthorizer.authorizeManage` split into `authorizeRegister(principal): AccessDecision`
(planner allow / couple forbidden) + `manageScope(principal): GuestScope` (`{kind:'all'}` planner /
`{kind:'wedding', wedding_id}` couple, from `principal.wedding_id` ONLY). `dispatchGuests` is per-method now
(GET scoped list / DELETE scoped remove / POST register-first). The two authorizers share only `AccessDecision`,
NOT a scope type (guest scope is a partition-FILTER, not a zero-or-one probe — unifying would couple unrelated
invariants). Named `manageScope` not `scope` (keeps the `…Scope` parallel with `listScope`, signals it scopes
list+remove). Registry got paired scope-agnostic methods (mirrors `weddings.list`/`weddings.get`):
`listForWedding` (partition filter; `undefined`→`[]`) + `removeForWedding`.

**Couple list = partition filter, oracle-free.** Bindings are keyed by `recipient_ref` not `wedding_id`, so
"my wedding's guests" MUST scan+filter the partition — and that's fine: no probed id, response carries only
matching bindings. Deliberately UNLIKE `wedding_authorizer.listScope`'s "never pull+filter" rule (which guards
a *specific probed id*).

**Couple remove = byte-identical on EVERY miss (a REGISTRY guarantee).** `removeForWedding(ctx, ref, wedding_id)`
deletes iff the stored binding's `wedding_id` matches; the four miss cases — absent / sibling-wedding /
foreign-tenant / `undefined` couple wedding_id — ALL return byte-identical `{removed:false}`. TWO must-fixes
make it hold: (1) **always `#repo.read` FIRST** (runs `assertMintedContext`+liveness on every path) then
conditionally `#repo.delete` — no pre-read `undefined` early-return — so a **suspended** tenant throws
`PRODUCT.TENANT_NOT_USABLE` on a miss exactly as on a hit (no error-vs-silent-false distinguisher); (2) the
`wedding_id` arg is `manageScope.wedding_id`, **never the body** (remove body carries ONLY `recipient_ref`) — a
body-smuggled `wedding_id` can't widen reach. A couple principal ALWAYS carries a `wedding_id`
(`SessionStore.login` rejects a couple login without one), so the `undefined` arm is defensive-only / unreachable
via a real principal.

**Browser:** `?view=guests` lights up for couples for FREE (`#guestsPage` only delegates to `api.handle()`); the
add-guest form is a **capability affordance** (couple submit → delegated planner-only 403 → re-render; forged CSRF
still masks 403 before the forward) — same call Phase 23 made for wedding-create ([[html-wedding-create-edit-forms]]).

ADR 0024, 793 tests, doddy+architect APPROVE design+built (both must-fix sets applied).
