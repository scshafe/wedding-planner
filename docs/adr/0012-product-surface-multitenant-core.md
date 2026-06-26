# ADR 0012 — The customer-facing product surface: the multi-tenant domain core

- **Status:** accepted
- **Date:** 2026-06-25
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-25-phase-12-product-surface-multitenant-core.md`)
- **Scope:** Phase 12 — the fifth domain `@wedding-planner/product`: the `tenant` + `wedding`
  aggregates (JSON Schema contracts 14 & 15), the white-label `theme`, and the tenant-isolation
  boundary (`TenantContext` + `TenantContextResolver` + `TenantScopedRepository` + `TenantStore` +
  `WeddingRepository`), proven by an adversarial keystone. Pure in-memory + injected clock/ids,
  offline. No HTTP, no UI, no auth principals (deferred).
- **Supersedes nothing.** It opens a new arc (the customer-facing surface) co-equal with the
  self-improvement engine, under the human course-correction
  [[customer-facing-product-surface-is-a-first-class-goal]]. It reuses the one safety model — this is
  the multi-tenancy analogue of the trusted-evidence firewall ([[prod-trusted-evidence-channel]]),
  not a parallel one.

## Context

The four domains built through Phase 11 (`eval-harness`, `telemetry`, `loop-orchestrator`,
`agent-operations`) are all **inward-facing** — they score, measure, improve, and operate the system
*itself*. For this to be the **business** it is meant to be, it needs the one thing it never had: a
**customer-facing product surface** — a **white-label, multi-tenant** web app real wedding planners
(and their couples) sign up for, theme, and use. The human owner ratified this as a first-class build
goal on 2026-06-25, built **offline-first, Docker-packaged, launch-ready** (onboarding/billing/comms
simulated; *going live* stays human-reserved — operations exception #4).

This is a multi-phase arc (12: domain core → 13: HTTP/auth → 14: UI → 15: onboarding/billing sim →
16: Docker). Phase 12 builds the foundation everything else sits on: the multi-tenant aggregates and,
load-bearing, the **tenant-isolation boundary**.

## Decision

Build the domain core and the isolation boundary FIRST, before any HTTP/UI. The repo's signature is
*prove the invariant at the seam, then build on it*. Multi-tenancy's invariant is **tenant
isolation** — a request carrying tenant A's identity can never read, list, or write tenant B's data.
Establishing it structurally now means the HTTP layer in Phase 13 *cannot* be the place isolation is
decided; it can only be the place a `TenantContext` is *resolved*. The boundary is the multi-tenancy
analogue of walling the trusted-evidence channel: fail closed, no existence oracle.

### The nine isolation invariants (each pinned by the keystone)

1. **The mint is slug-keyed** — `resolveBySlug(slug)`. A slug is the untrusted routing primitive a
   future request router actually carries, so the boundary survives contact with Phase 13.
2. **`TenantContext` is unforgeable** — a compile-time phantom `declare`d `unique symbol` brand
   (type-only nominal typing) + a runtime **identity WeakSet** (`MINTED_CONTEXTS`) the resolver is the
   sole adder of. Membership is by object identity and lives *outside* the object, so it cannot be
   reflected off a real context and copied onto a forged one. The minted context is `Object.freeze`d.
3. **Every repository entry runs `assertMintedContext`** (rejects a forged/cast object,
   `PRODUCT.FORGED_CONTEXT`) — the runtime half of unforgeability; compile-time alone is insufficient
   for a plain-JS caller.
4. **The partition key is `ctx.tenant_id` ONLY** — a record's own `tenant_id` is compare-only (never
   routes the partition), on create and update alike.
5. **No existence oracle** — `read` returns `T | undefined`; a foreign-tenant id and a never-existed
   id return the byte-identical `undefined` via the same code path, with no side effect.
6. **Liveness re-asserted at use, fail closed** — every op re-checks `TenantStore.isUsable`; a context
   held past a suspension stops working (`PRODUCT.TENANT_NOT_USABLE`). The context carries no cached
   lifecycle authority — it is a short-lived, single-request snapshot.
7. **Cross-tenant write vetoed** — a payload `tenant_id` ≠ the context is rejected
   (`PRODUCT.CROSS_TENANT_WRITE`), no silent coercion.
8. **Global slug uniqueness, normalized** — `slug` is unique across all tenants on the lowercased form
   (the schema `pattern` pins `[a-z0-9-]`), so case/homograph variants can't fork a tenant.
9. **No unscoped accessor; private backing maps** — no all-tenants read; the partition maps are
   `#`-private (ES private), so reflection/serialization leaks nothing.

The lookup key is `(tenant_id, id)`; `id` alone is never a key, so two tenants may hold the same
`wedding_id` with zero collision — corrected from an early (false) "ids are tenant-namespaced" claim
(`SequentialIdGenerator` has a global per-prefix counter).

## Alternatives considered

- **HTTP/UI first, isolation in middleware.** Rejected: isolation decided in transport is
  bypassable by any code path that skips the middleware. The domain boundary cannot be routed around.
- **Symbol-property brand on the context.** Built first, then rejected at doddy's re-review: a real
  `unique symbol` own property is reflectable via `Object.getOwnPropertySymbols` and copyable onto a
  forged object (the re-stamp attack). The WeakSet identity token closes it by construction.
- **`tenant_id`-keyed resolver.** Rejected (architect P1-A): a raw `tenant_id` is not what a request
  carries; a slug-keyed mint is what survives contact with routing.
- **Theme as a separate aggregate.** Rejected: a theme has no identity or lifecycle independent of its
  tenant — a value object, nested. (Revisit only if Phase 14 needs theme versioning.)

## Consequences

- The product domain is the seam where the planning **engine** (strategy genome / North Star per
  wedding) connects in a later phase; the `wedding` aggregate is left minimal for that.
- **Scope of the proof:** Phase 12 proves **inter-tenant** isolation only. *Intra-tenant*
  authorization (planner vs couple — billing visibility, own-wedding-only) is a distinct, finer-grained
  boundary that lands with principals in Phase 13.
- **Bounded residual:** the slug index is a *deliberate* global existence oracle (slug presence is
  observable) — acceptable because a slug is non-secret routing metadata, and `resolveSlug` returns
  routing-only data, never wedding/private payload.
- Offline-first preserved: in-memory, deterministic, no network/money/comms. `plan_tier` /
  `lifecycle_status` are simulated fields; their state-machine simulations land in Phase 15.

See memory [[multi-tenant-isolation-boundary]].
