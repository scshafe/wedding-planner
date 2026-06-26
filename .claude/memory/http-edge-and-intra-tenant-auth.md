---
name: http-edge-and-intra-tenant-auth
description: "Phase 13 — the product surface's HTTP request edge + simulated auth; the INTRA-tenant authorization boundary (planner vs couple) stacked on Phase 12's inter-tenant isolation, with a 5-stage pipeline, a WeakSet-branded Principal, and a couple-non-owned->byte-identical-404 mask (no intra-tenant existence oracle)"
metadata:
  node_type: memory
  type: project
---

**Phase 13 built the product surface's transport edge** ([[multi-tenant-isolation-boundary]] is the
layer below): a pure HTTP handler (`ProductApi.handle: ApiRequest -> ApiResponse`, no socket coupling)
+ a thin Node `http` adapter (`createProductApiServer`, the ONLY socket-touching code), and the
**simulated auth/session** layer (`Principal`, `SessionStore`, `WeddingAuthorizer`). ADR 0013.
Offline-first (Node built-in `http`, zero new runtime deps, injected clock/ids). The keystone is
`product/tests/http/product_api_keystone.test.ts`.

**Two stacked boundaries now; the edge can route around NEITHER.** Inter-tenant = the Phase-12
`TenantContext` (by construction). Intra-tenant (NEW) = a `Principal` — `planner` (sees the whole
tenant) vs `couple` (bound to ONE `wedding_id`). The load-bearing pieces:

- **One 5-stage pipeline:** parse → resolve tenant (slug from the route → `resolveBySlug` = the SOLE
  per-request context mint) → authenticate (Bearer token → `sessionStore.resolve`) → **bind**
  (`principal.tenant_id === context.tenant_id`, else 401 — the cross-tenant replay veto; a session for
  A on B's route is rejected, never re-scoped to A) → authorize+dispatch.
- **Handler purity is STRUCTURAL, not prose** (architect P1-A): the pipeline (the `ProductApi`
  instance) is the only holder of `resolver`/`sessionStore`; the dispatch handlers are module-level
  functions taking only `(ctx, principal, req)` + a narrow `{weddings, authorizer}` bag. A
  `TenantContext` can only be minted by the resolver, and a handler has no resolver in scope → it
  physically cannot fabricate a foreign-tenant context.
- **`SessionStore` is the sole mint of a `Principal`** (the auth analogue of resolver-is-sole-mint).
  Token = a server-issued OPAQUE handle (injected id), not a client claim → no client-asserted
  tenant_id/role. The principal's tenant_id comes from the RESOLVED context, never a slug echo.
- **`Principal` is branded by a module-private WeakSet** (same mechanism as `TenantContext`, for the
  same doddy reason: a forged `couple` naming a different wedding_id is an intra-tenant escalation if
  the authorizer trusts a structural object). `assertMintedPrincipal` at the authorizer's entry. The
  brand symbol + `mintPrincipal` are NOT exported from the barrel.
- **No intra-tenant existence oracle — the crux.** A couple addressing a NON-owned wedding is masked as
  a **byte-identical 404** to a missing wedding. Ownership is decided STRUCTURALLY from
  `principal.wedding_id`, BEFORE/WITHOUT any repo lookup — so foreign-exists, own-but-absent, missing,
  and unknown-route all return the SAME frozen `RESP_NOT_FOUND` constant. A *capability* the role lacks
  entirely (couple create) is 403 (no specific resource probed). `errorToResponse` is the single
  code→status map and emits code-free constant bodies (no `error.code`/`error.context` leak). Stage
  precedence pinned: tenant-resolve(404)/auth+bind(401) BEFORE any 405/route-shape check (route shape
  is not a pre-auth oracle). For PUT, authorize→mask runs BEFORE body parse.
- **Login is a labeled SIMULATION with no oracle** (doddy P0): requires only the tenant usable (so a
  suspended tenant 404s at stage 2, can't even log in); does NOT verify a real credential and does NOT
  confirm the couple's `wedding_id` — verifying existence would make the unauthenticated login endpoint
  the loudest oracle. A phantom id is carried opaquely; the difference surfaces only, masked, at read.
- **Body smuggling closed:** create takes no tenant_id/wedding_id from the body (server-mints id, stamps
  tenant from context; the scoped `put` also vetoes a mismatching payload tenant_id); update
  reconstructs explicitly with `wedding_id` from the ROUTE and `tenant_id` from the CONTEXT applied
  LAST; `parseObjectBody` strips `__proto__`/`constructor`/`prototype` and reads fields by name (never
  blind-spread); the wedding schema is `additionalProperties:false`. The `status` cast is safe only
  because schema validation runs DOWNSTREAM of it (keep that order on refactor).

**Error→status map** (one place): UNKNOWN_TENANT/TENANT_NOT_USABLE/ROUTE_NOT_FOUND/masked → 404;
NO_SESSION/SESSION_TENANT_MISMATCH → 401; FORBIDDEN → 403; BAD_REQUEST/VALIDATION_FAILED/CONTRACT.VALIDATION_FAILED
→ 400; METHOD_NOT_ALLOWED → 405; FORGED_CONTEXT/FORGED_PRINCIPAL/CROSS_TENANT_WRITE/anything else → 500
(an internal invariant a real request can't construct; never a client path, never leaked). NOTE the
catch is on `WeddingPlannerError` (broader than `ProductError`) so the shared `CONTRACT.VALIDATION_FAILED`
from a bad create/update maps to 400, not 500.

**Scope / deferred:** field-level couple write policy (a couple may not `cancel`) → later; real
credential verification, crypto tokens (JWT/expiry), persistence, slow-loris timeouts → hardening for
going-live (human-reserved). doddy re-reviewed the BUILT edge: nothing exploitable (no P0/P1/P2).
Next: Phase 14 (the web UI, themed per tenant) — see [[customer-facing-product-surface-is-a-first-class-goal]].
