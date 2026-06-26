# Phase 12 — The customer-facing product surface: the multi-tenant domain core

## Why this, why now

Phases 1–11 built the **engine**: every North-Star input is trusted-backed, the offline loop
improves a champion under one safety model, and an advisory pass surfaces tier-2 recommendations.
All four domains are **inward-facing** — they score, measure, improve, and operate the system
*itself*. The human owner's 2026-06-25 course-correction (`CLAUDE.md` "The product direction";
memory [[customer-facing-product-surface-is-a-first-class-goal]]) makes the **customer-facing
product surface** a first-class, co-equal goal: a **white-label, multi-tenant** web app real wedding
planners — and their couples — sign up for, theme, and use. Everything so far is the engine; this is
the car. The handoff ranks it the **#1 strategic lever**, and the offline-loop levers are all
incremental, so this run **starts the arc**.

The product surface is a multi-phase arc, built **offline-first, Docker-packaged, launch-ready**
(onboarding/billing/comms simulated; going live stays human-reserved — exception #4). The planned
sequence (mine to revise as I learn):

- **Phase 12 (this plan) — the multi-tenant domain core.** The foundation: the `tenant` (planner
  org) and `wedding` aggregates, the white-label theme, and — load-bearing — the **tenant-isolation
  boundary** proven by an adversarial keystone. Pure domain + in-memory stores, offline, no HTTP yet.
- Phase 13 — the HTTP API + simulated auth/session (tenant resolved from the request; isolation
  enforced at the boundary; planner vs couple principals).
- Phase 14 — the web UI (planner console + couple view), themed per tenant.
- Phase 15 — onboarding + billing simulation (the offline simulations).
- Phase 16 — Docker packaging → the deployable, launch-ready image.

**Why the domain core first (not HTTP/UI first):** the repo's signature is *load-bearing invariants
proven by adversarial tests*. Multi-tenancy's load-bearing invariant is **tenant isolation** — a
request carrying tenant A's identity can never read, list, or write tenant B's data. That is the
multi-tenancy analogue of the trusted-evidence firewall ([[prod-trusted-evidence-channel]]: wall the
*channel*, fail closed, no existence oracle). Establishing it structurally now — before any HTTP
handler or UI can accidentally route around it — is the same "prove the invariant at the seam, then
build on it" discipline every prior phase used. Phases 13–16 inherit a boundary they cannot bypass.

## The design: the fifth domain `product/`, isolation as a structural property

A new workspace `@wedding-planner/product` (the fifth domain), matching every repo convention:
schemas-as-contracts, structured `PRODUCT.*` errors, injected clock/ids, tests mirroring source,
`@canonical` tags, the public barrel.

**Aggregates (Phase 12 scope — deliberately minimal):**

1. **Tenant** — a wedding-planner organization (the white-label customer). `tenant_id`, `slug`
   (the globally-unique white-label routing key — a subdomain/path segment), `display_name`,
   `theme` (white-label: `brand_name`, `primary_color_hex`, `accent_color_hex`, `logo_ref`),
   `plan_tier` (simulated billing tier — enum), `lifecycle_status` (simulated onboarding/billing
   state — enum, e.g. `onboarding`/`active`/`suspended`), `created_at` (injected clock).
2. **Wedding** — a couple's wedding, owned by **exactly one** tenant. `wedding_id`, `tenant_id`,
   `couple_display_name`, `event_date`, `status`, `created_at`. This is the aggregate the planner and
   the couple collaborate on; it is where the planning **engine** connects in a later phase (a wedding
   will carry a strategy genome / North Star). Kept minimal here.

Users / auth principals are **deferred to Phase 13** — Phase 12's principal is the `TenantContext`
alone (the resolved, validated tenant identity), so the isolation boundary can be proven without a
full auth simulation muddying it.

**The canonical isolation boundary — `TenantContext` + `TenantScopedRepository`.** The nine
load-bearing invariants (each tied to a design-review finding; each pinned by the keystone):

1. **The mint is slug-keyed** (architect P1-A). The resolver's trust-boundary entry is
   `resolveBySlug(slug): TenantContext` — `slug` is the untrusted routing primitive the future router
   actually carries (Host header / path segment), so the boundary survives contact with Phase 13. An
   internal `tenant_id` lookup may exist, but the *mint* is slug-keyed. Rejects unknown →
   `PRODUCT.UNKNOWN_TENANT`, unusable lifecycle → `PRODUCT.TENANT_NOT_USABLE`.
2. **`TenantContext` is unforgeable — branded + frozen** (doddy P1, architect P1-C; the CENTRAL
   finding). TypeScript is structural: a bare `{ tenant_id }` is assignable wherever a `TenantContext`
   is expected, so "resolver is the only mint" is *convention, not construction*, unless the type
   carries a witness only the resolver can stamp. `TenantContext` carries a **module-private `unique
   symbol`** brand; the resolver is the only code that stamps it; the minted object is
   `Object.freeze`d so `tenant_id` cannot be mutated post-mint (`readonly` is compile-time only).
3. **Every repository entry runs `assertMintedContext(ctx)`** (doddy P1). A runtime guard at the top
   of every read/list/write rejects an unbranded / hand-built / cast object with
   `PRODUCT.FORGED_CONTEXT`. Compile-time alone is insufficient — the real caller (Phase 13 request
   code, tests with `as any`) operates in plain JS at runtime.
4. **The partition key is `ctx.tenant_id` ONLY** (doddy P1, architect P1-B). The backing map is keyed
   by `ctx.tenant_id`; a record's own `tenant_id` is *only ever compared* (to veto), **never used to
   select/route** the partition — on *both* create and update paths. No repository method takes a
   partition key as a separate argument.
5. **No existence oracle, pinned exactly** (doddy P2). Read-by-id returns a **value** (`T |
   undefined`), not a throw — a foreign-tenant id and a never-existed id return the *byte-identical*
   `undefined`, via the *same code path*, with no distinguishing side effect (no log/ledger entry on
   the foreign path that the missing path lacks). Shrinks the oracle surface to nothing.
6. **Liveness re-asserted at USE, fail closed** (doddy P2, architect P2-B). A context minted while
   tenant A was `active` must NOT keep working after A is suspended. The repository holds an injected
   liveness check (the `TenantStore`'s `isUsable`) and re-asserts the tenant is usable on *every*
   operation, failing closed with `PRODUCT.TENANT_NOT_USABLE`. This is the trusted-evidence
   "liveness asserted, absence fails closed" principle ([[prod-trusted-evidence-channel]]), not a
   mint-time-only check. `TenantContext` carries no cached lifecycle authority; it is a short-lived,
   single-request snapshot.
7. **Write under A stamps A's `tenant_id`; a foreign `tenant_id` in the payload is vetoed**
   (`PRODUCT.CROSS_TENANT_WRITE`) — explicit veto, no silent coercion that hides a bug.
8. **Global slug uniqueness, normalized** (architect P3-A). The `slug` is unique across *all* tenants,
   enforced in `TenantStore` (`PRODUCT.DUPLICATE_SLUG`) on the **normalized** form (lowercase,
   `[a-z0-9-]`, pinned in the schema `pattern`) so case/homograph collisions can't fork a tenant.
9. **No unscoped accessor; private backing maps** (architect P2-A, doddy P2/H). The repository exposes
   *no* all-tenants/context-less read (not even "internal"). Backing maps are `#private`; no
   `toJSON`/enumerable field leaks the partition map under `{...repo}` / `JSON.stringify`.

**The lookup-key invariant (correcting the id model).** Ids are NOT tenant-namespaced —
`SequentialIdGenerator.next('wedding')` is `wedding_<seed>_n` with a global per-prefix counter, so two
tenants' first weddings *can* share `wedding_<seed>_1`. That is harmless **because the lookup key is
`(tenant_id, id)` and `id` alone is NEVER a key**. The keystone asserts the *deliberate-collision*
case directly (two partitions, same intra-partition id, each resolves to the right tenant's record).

**Bounded, named residual** (architect P3-B): the slug index is a *deliberate* global existence oracle
(slug presence is observable) — acceptable because slug is non-secret routing metadata, not a
credential, and slug resolution returns routing-only data, never wedding/private payload (doddy P3).

**Scope of the proof** (architect P2-E): Phase 12 proves **inter-tenant** isolation only.
*Intra-tenant* authorization (planner vs couple — a couple editing billing, seeing only their wedding)
is a **distinct, finer-grained** boundary landing with principals in Phase 13; this keystone does not
cover it.

**The keystone (the load-bearing regression):** an adversarial test that a tenant context can never
cross the boundary — read, list, or write — and that the brand, no-oracle, liveness, and
deliberate-collision properties all hold. This is the multi-tenancy firewall; Phases 13–16 are built
on top of it and may not weaken it.

## How it fits the one safety model (not a parallel one)

- **Per-tenant isolation = the prod-trusted-evidence-channel analogue** ([[prod-trusted-evidence-channel]]):
  wall the *channel* (here, the tenant scope) structurally; fail closed; no oracle. Same shape, new
  surface — not a second safety model.
- **Offline-first preserved.** Pure in-memory domain + injected clock/ids; no network, money,
  booking, or comms. Onboarding/billing/comms are *simulated enums/fields* here, fully offline.
- **Couples' wedding spend** (when it lands in a later phase) still follows [[spend-autonomy-model]];
  the *business's* pricing/contracts/strategy autonomy stays human-reserved
  ([[white-label-growth-and-agent-strategy-autonomy]]) — Phase 12 builds only the technical surface.
- **Contracts-as-source-of-truth.** Tenant/wedding are JSON Schemas registered in the manifest
  (13 → 15), validated through the existing `schema_registry`, never redefined.

## Steps

- [x] **Step 0 — Design reviews folded.** Ran the `rigorous-architect` and `doddy` (trust-boundary)
  lenses over this plan *before building* (via `general-purpose` agents carrying the persona, per the
  handoff note that the named sub-agents aren't provisioned here). Both **APPROVE-WITH-CHANGES**.
  Findings folded into the nine-invariant boundary spec above: slug-keyed mint (arch P1-A); branded +
  frozen unforgeable context + `assertMintedContext` at every entry (doddy P1, arch P1-C — the central
  finding); partition key = `ctx.tenant_id` only, compare-only payload (doddy P1, arch P1-B); no-oracle
  pinned to a value-returning read with no side-effect skew (doddy P2); liveness re-asserted at use /
  fail closed (doddy P2, arch P2-B); corrected lookup-key/id model (doddy P1-F); normalized global slug
  + named residual (arch P3-A/P3-B, doddy P3); no unscoped accessor + private maps (arch P2-A, doddy H);
  inter-tenant-only scope note (arch P2-E). _(Documentation-only; tick on commit.)_

- [x] **Step 1 — The `product/ workspace skeleton.** `product/package.json`
  (`@wedding-planner/product`, `"type":"module"`, `exports: "./src/index.ts"`); register in root
  `package.json` `workspaces`, `tsconfig.json` `paths` + `include`, and `vitest.config.ts` `alias`.
  Add `product/src/index.ts` (barrel), `product/src/product_error.ts` (`class ProductError extends
  WeddingPlannerError`), and `product/README.md` (the domain's spec, in the four-domains house style).
  Verify `npm run build && npm test && npm run lint` green (workspace empty but wired).

- [x] **Step 2 — Product schemas-as-contracts.** `product/schemas/tenant_schema.json` and
  `product/schemas/wedding_schema.json` (draft 2020-12, `additionalProperties:false`, `$id` under
  `https://wedding-planner.eval/schemas/`). Register both in `shared/src/contracts/contract_manifest.ts`
  (`ContractKey` + `CONTRACT_DEFINITIONS`, domain `'product'`); bump the drift test
  (`schema_registry.test.ts`: `CONTRACT_COUNT` 13 → 15). `npm run gen:types`; re-export the generated
  `Tenant` / `Wedding` types through the `product` barrel. Green (the drift guard now passes at 15).

- [x] **Step 3 — The domain core + isolation boundary.**
  - `product/src/tenant/tenant_store.ts` (`@canonical tenant_store`) — registers tenants, enforces
    **normalized** global slug-uniqueness (`PRODUCT.DUPLICATE_SLUG`), validates against the tenant
    schema on create, exposes `isUsable(tenant_id)` (the liveness check, inv. 6) and a routing-only
    `resolveSlug(slug)` (inv. residual). `#private` backing map (inv. 9).
  - `product/src/tenant/tenant_context.ts` (`@canonical tenant_context`) — the **branded** opaque
    `TenantContext` (module-private `unique symbol`, inv. 2), `assertMintedContext` (inv. 3,
    `PRODUCT.FORGED_CONTEXT`), and the `TenantContextResolver` (the *only* mint;
    `resolveBySlug(slug)` per inv. 1; `Object.freeze`s the minted context; rejects unknown →
    `PRODUCT.UNKNOWN_TENANT`, unusable → `PRODUCT.TENANT_NOT_USABLE`). The brand symbol and any
    context-constructor are **never exported from the barrel** (doddy P3 follow-through).
  - `product/src/tenant/tenant_scoped_repository.ts` (`@canonical tenant_scoped_repository`) — the
    generic store, `#private` partition map keyed by `ctx.tenant_id` ONLY (inv. 4). Every method runs
    `assertMintedContext(ctx)` then re-asserts `isUsable` (inv. 3, 6). `read(ctx,id): T | undefined`
    returns the byte-identical `undefined` for foreign-id and missing-id via one code path (inv. 5);
    `list(ctx)` returns only the context partition; write stamps `ctx.tenant_id`, vetoes a foreign
    payload `tenant_id` (`PRODUCT.CROSS_TENANT_WRITE`, inv. 7) on create AND update; NO unscoped
    accessor (inv. 9).
  - `product/src/wedding/wedding_repository.ts` (`@canonical wedding_repository`) — `WeddingRepository`
    over the scoped repository; create stamps the context tenant; validates against the wedding schema.
  - Injected `Clock` + `IdGenerator` throughout (no ambient time/RNG). Happy-path unit tests for each.

- [x] **Step 4 — The tenant-isolation keystone**
  (`product/tests/tenant/tenant_isolation_keystone.test.ts`). The load-bearing regression. With two
  tenants A and B each owning a wedding, assert: (a) **read** of B's `wedding_id` under context A →
  `undefined`, *byte-identical* (deep-equal value + same code path, no side effect) to reading a
  never-existed id (no existence oracle, inv. 5); (b) **list** under A returns exactly A's weddings,
  never B's; (c) **write/update** under A cannot mutate B's wedding and cannot create/update a wedding
  carrying B's `tenant_id` (`PRODUCT.CROSS_TENANT_WRITE`) — assert the partition is selected by context
  on BOTH paths (inv. 4, 7); (d) **forged-context attacks**: (i) a hand-built `{tenant_id:'A'} as
  TenantContext` passed straight to the repo is rejected (`PRODUCT.FORGED_CONTEXT`, inv. 3 — the
  bypass-the-resolver attack, NOT merely resolver-rejects-unknown); (ii) a frozen context's
  `tenant_id` cannot be mutated (inv. 2); (iii) `resolveBySlug` of an unregistered slug →
  `PRODUCT.UNKNOWN_TENANT`; (e) **liveness**: a context minted while A is `active`, then A suspended,
  fails closed on the next operation (`PRODUCT.TENANT_NOT_USABLE`, inv. 6); (f) two tenants cannot
  share a `slug` incl. case-variant (`PRODUCT.DUPLICATE_SLUG`, inv. 8); (g) **deliberate id
  collision**: two weddings forced to the same `wedding_id` in partitions A and B each resolve to the
  right tenant's record under their own context (lookup key is `(tenant_id,id)`, inv. lookup-key); (h)
  **no leak via serialization**: `JSON.stringify(repo)` / `{...repo}` / `Object.keys(repo)` reveal no
  tenant data (inv. 9).

- [x] **Step 5 — doddy boundary re-review of the BUILT code.** Trace the real seams: the resolver is
  the sole `TenantContext` mint; no repository method accepts a raw `tenant_id` that bypasses a
  context; the not-found path leaks nothing (no timing/shape/error-code oracle); the slug global index
  holds no tenant-private data. Apply findings before ticking.

- [x] **Step 6 — ADR 0012 + memory + README + handoff.**
  `docs/adr/0012-product-surface-multitenant-core.md` (the fifth domain; isolation as the firewall
  analogue; the deferred phases). Memory `multi-tenant-isolation-boundary.md` (+ MEMORY.md index):
  the resolver-is-sole-mint invariant, no-existence-oracle, cross-tenant-write veto, global-slug
  index, link [[prod-trusted-evidence-channel]] / [[customer-facing-product-surface-is-a-first-class-goal]].
  Add the `product/` row to the README four-domains table + a "the product surface" status note.
  Update `.claude/handoff.local.md`.

## Out of scope (recorded, not faked)

- **HTTP / API / auth principals / sessions** — Phase 13. Phase 12's principal is the `TenantContext`
  alone; the boundary is proven at the domain layer first so the HTTP layer inherits it.
- **Web UI / theming render** — Phase 14. The theme is *modeled* here (data), not *rendered*.
- **Onboarding / billing / comms simulation logic** — Phase 15. Phase 12 models `lifecycle_status` /
  `plan_tier` as fields; the state-machine simulations come later.
- **Docker packaging** — Phase 16 (the launch-ready deliverable).
- **Persistence beyond in-memory** — a real datastore is a Phase 13+ concern; the repository interface
  is designed so a persistent impl drops in behind the same isolation contract. In-memory keeps Phase
  12 offline, deterministic, and fast.
- **Connecting a wedding to the planning engine** (strategy genome / North Star per wedding) — a later
  phase once the surface exists; the `wedding` aggregate is the seam, left minimal here.
