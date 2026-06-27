# ADR 0024 — Couple-scoped guest management (list + remove their own wedding's guests)

- **Status:** accepted
- **Date:** 2026-06-27
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-27-phase-24-couple-scoped-guest-management.md`)
- **Scope:** Phase 24 — resolve the Phase-21 tripwire by giving a **couple** a resource-scoped slice of the
  guest-management surface: **list and remove the guests of the one wedding they are bound to**. `register`
  stays planner-only. This is the guest analogue of `wedding_authorizer`'s couple-vs-planner resource decision.
  **No new schema, no new contract, no new safety model.**
- **Builds on** the Phase-21 planner guest surface + CSRF ([[planner-guest-management-and-csrf]]), the Phase-13
  intra-tenant auth ([[http-edge-and-intra-tenant-auth]]), and the Phase-12 tenant-scoped registry. Reuses the
  one safety model — **no parallel one**.

## Context

Phase 21 deliberately made guest management **planner-only** (`GuestAuthorizer.authorizeManage` → `forbidden`
for a couple) and left "a couple managing their OWN wedding's guests" as a documented future refinement — the
tripwire. Before this rung a couple could not see or manage even their own wedding's guests through the product
surface. This rung opens that slice while holding the no-existence-oracle discipline that governs every
intra-tenant decision.

The crux — discovered during the Phase-23 run and confirmed by both design reviewers here — is that
**couple-REGISTER is NOT oracle-safe, but couple list+remove ARE**. So this rung ships list+remove and defers
register with the oracle written up.

Two adversarial reviews (doddy security + rigorous-architect, via `general-purpose` agents carrying the persona
lens — the named specialists are not provisioned here) ran on the DESIGN: both **APPROVE-WITH-FIXES**, all fixes
applied before/while building. 793 tests green (was 781).

## Decisions

### 1. `register` stays planner-only — the tenant-global `recipient_ref` 409 is a cross-wedding existence oracle

`recipient_ref` is the registry's **tenant-GLOBAL** partition key (one ref → one wedding across the whole
tenant). If a couple could register, registering a ref already bound to **another** wedding throws
`PRODUCT.GUEST_ALREADY_REGISTERED` (409) — a couple would learn the ref is bound *somewhere* in the tenant, and a
couple-scoped list (showing only their own wedding's guests) cannot cross-reference the conflict away. Masking
the 409 to a fake success would corrupt the planner's own registration semantics. So `register` remains a
**capability a couple lacks entirely** (`authorizeRegister` → `forbidden` → 403). A clean couple-register
(per-wedding ref namespacing, or a masked-conflict semantics that doesn't corrupt the planner path) is its own
future rung.

**MUST-FIX (doddy): `authorizeRegister` is the LITERAL first statement of `handleGuestRegister`** — before the
body parse, before the referential-integrity 404, and before the duplicate-409. So a couple POST (even one
carrying a duplicate ref, even a malformed body) is a **constant 403**, never reaching the 409 that would re-leak
the deferred oracle, and never distinguishable by body shape. Proved by a test: a fresh-ref and a
duplicate-ref couple POST are byte-identical 403, and a junk body is the same 403.

### 2. The single `authorizeManage` gate splits into a CAPABILITY check + a SCOPE

`GuestAuthorizer` now exposes `authorizeRegister(principal): AccessDecision` (planner allow / couple forbidden)
and `manageScope(principal): GuestScope` (`{ kind:'all' }` for a planner; `{ kind:'wedding', wedding_id }` for a
couple, derived ONLY from `principal.wedding_id`). `dispatchGuests` is now **per-method**: GET → scoped list,
DELETE → scoped remove, POST → `authorizeRegister`-first. An unknown method → 405 for all (the route exists
tenant-independently, so 405 is not a tenant oracle). This mirrors `wedding_authorizer`'s `ListScope`/`listScope`
shape; the two authorizers share only the `AccessDecision` vocabulary, not a scope type (the guest scope is a
genuinely different shape — a partition filter, not a zero-or-one probe — so unifying would couple unrelated
invariants).

**Naming (architect MUST-FIX):** the scope method is `manageScope`, not a bare `scope` — it keeps the `…Scope`
parallel with `listScope` while signalling it scopes the whole manage surface (list **and** remove), not list
alone.

### 3. Couple `list` filters the partition by `wedding_id` — oracle-free because there is no probed id

A guest binding is keyed by `recipient_ref` (not `wedding_id`), so "all guests of MY wedding" is a `wedding_id`
filter over the tenant partition (`registry.listForWedding`) — unavoidable, and oracle-free: the filter runs
in-process and the RESPONSE carries only the matching bindings, disclosing nothing about other weddings' guests.
This is **deliberately unlike** `wedding_authorizer.listScope`'s "never pull+filter the partition" rule, which
guards a *specific probed id*; here there is no probed id, just "give me mine", so the scan leaks nothing a couple
couldn't already enumerate. The planner's whole-tenant `list` is unchanged.

### 4. Couple `remove` is `wedding_id`-scoped and **byte-identical on every miss** (a registry guarantee)

`registry.removeForWedding(context, recipient_ref, wedding_id)` deletes only if the stored binding's `wedding_id`
matches; otherwise it no-ops `false`. The four non-success cases — `recipient_ref` absent, bound to a **sibling**
wedding, bound to a **foreign tenant** (read → undefined), and an `undefined` couple `wedding_id` — ALL return
the byte-identical `{ removed:false }`. A `removed:true` only ever names a guest the couple could already list, so
it reveals nothing new. The byte-identical-miss property is a **registry** guarantee, asserted in the handler
tests across absent / sibling / smuggled-wedding_id.

**MUST-FIX (doddy): `removeForWedding` ALWAYS runs `#repo.read` first** (which runs `assertMintedContext` +
liveness on **every** path), then conditionally `#repo.delete`. No pre-read `undefined` early-return. Consequence
proved by a test: on a **suspended** tenant a miss throws `PRODUCT.TENANT_NOT_USABLE` exactly as a hit would — a
suspended couple cannot distinguish a miss from a hit by error-vs-silent-false.

**MUST-FIX (doddy): the `wedding_id` passed to `removeForWedding` is `manageScope.wedding_id`, never the body.**
The remove body carries only `recipient_ref` (the delete key). A body-smuggled `wedding_id` cannot widen a
couple's reach — proved by a test deleting a sibling's ref while smuggling the sibling's `wedding_id`: still
`{ removed:false }`, sibling binding untouched.

### 5. The browser `?view=guests` page lights up for couples for free; the add-guest form is a capability affordance

`#guestsPage` only delegates to `api.handle()`, so once GET `/guests` returns 200 for a couple the page renders
their scoped list with **no web-layer code change**. The add-guest (register) form has no role signal to hide it
(the guests-list contract carries none — a couple can list, so a 200 is not a planner-only gate), so it stays
shown to all and a couple's submit takes the honest themed re-render (the delegated planner-only POST → 403 →
`#guestsPage(…, invalid)`). This is the **same call Phase 23 made** for wedding-create ([[html-wedding-create-edit-forms]]).
A forged CSRF on the couple add-form still masks 403 **before** the delegated forward (no mutation). Couple
remove works through the existing CSRF-gated `/guests/remove` form unchanged.

## Consequences

- A couple is now a first-class manager of **their own wedding's** guest list through both the JSON API and the
  themed browser page — list + remove — while the planner's whole-tenant surface is byte-for-byte unchanged.
- The compose-level e2e closes end-to-end through the **wired** surface: a couple logs in via the public edge,
  lists the demo wedding's seeded guest (scoped), and removes it.
- No new schema (the 18-schema manifest is unchanged); no JSON contract change; the one safety model is reused.
- 793 tests green (was 781): new `guest_authorizer.test.ts`; registry scope + suspended-tenant liveness cases;
  couple-scoped list/remove + register-403 + byte-identical-miss in `guest_api.test.ts`; couple browser cases in
  `guest_web.test.ts`; one compose e2e. doddy + architect APPROVE the design (must-fixes applied in the build).

## Alternatives considered

- **Ship couple-register too** — rejected: the tenant-global `recipient_ref` 409 is a cross-wedding existence
  oracle a couple-scoped list can't mask; deferred to its own design rung (above).
- **Pass the scope object into the registry** — rejected: keeps the registry scope-aware (auth concern leaking
  into the store). Mirroring `handleList`'s branch-in-handler with paired scope-agnostic registry methods
  (`list`/`listForWedding`, `remove`/`removeForWedding`) matches `weddings.list`/`weddings.get`.
- **Hide the add-guest form from couples by role** — rejected: needs a role signal the list contract doesn't
  carry; the capability 403 is the honest, oracle-free boundary (consistent with Phase 23 wedding-create).
- **A shared scope type across both authorizers** — rejected: the guest scope is a partition-filter shape, not a
  zero-or-one probe; unifying would couple unrelated invariants. They share only `AccessDecision`.
