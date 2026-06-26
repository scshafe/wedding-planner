# ADR 0013 — The HTTP API + simulated auth/session: the intra-tenant authorization boundary

- **Status:** accepted
- **Date:** 2026-06-25
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-25-phase-13-http-api-auth-session.md`)
- **Scope:** Phase 13 — the customer-facing product surface's transport edge: a pure HTTP request
  handler (`ProductApi`) over a 5-stage pipeline, a thin Node `http` socket adapter
  (`createProductApiServer`), and the **simulated auth/session** layer (`Principal`, `SessionStore`,
  `WeddingAuthorizer`) — the **intra-tenant** authorization boundary (planner vs couple) Phase 12
  deferred. Offline-first (Node built-in `http`, zero new runtime deps, injected clock/ids). Proven by
  an adversarial HTTP keystone.
- **Builds on** ADR 0012 (the inter-tenant isolation boundary). It does not weaken it; it drives it
  from a request and stacks a second, finer boundary on top, reusing the one safety model
  ([[prod-trusted-evidence-channel]]) — not a parallel one.

## Context

Phase 12 built the inter-tenant isolation boundary at the **domain** layer — a `TenantContext` for
tenant A can never read/list/write tenant B's data, enforced by construction. But nothing drove it
from a request, and Phase 12 explicitly deferred the **intra-tenant** boundary: within one tenant,
the tenant's staff (`planner`) sees everything, but a `couple` may act only on their own wedding. The
product arc needs a request edge before the UI (14), onboarding/billing (15), and Docker (16) phases —
and that edge must be a place where a `TenantContext` is *resolved*, never where isolation is
*decided*.

## Decision

A single ordered request pipeline, with two stacked boundaries, where the handlers are structurally
incapable of routing around either.

### The 5-stage pipeline (one path, no bypass)

1. **Parse** — method, path segments, (later) body.
2. **Resolve tenant** — slug from the route (`/t/:slug/...`) → `resolver.resolveBySlug` → the **sole
   per-request mint** of a `TenantContext`. Unknown/unusable → `404` (no absent-vs-suspended oracle).
3. **Authenticate** — `Authorization: Bearer <token>` → `sessionStore.resolve` → `Principal`. None →
   `401`.
4. **Bind** — `principal.tenant_id === context.tenant_id`, else `401` (the cross-tenant replay veto):
   a session for A on B's route is rejected, never re-scoped to A, never dispatched into B.
5. **Authorize + dispatch** — the handler applies the `WeddingAuthorizer`, then calls the Phase-12
   repository **with the context**.

**Handler purity is structural, not prose.** The pipeline (the `ProductApi` instance) is the only code
that holds the `resolver` and `sessionStore`; the dispatch handlers are module-level functions taking
only `(context, principal, req)` + a narrow `{ weddings, authorizer }` bag. Because a `TenantContext`
can only be minted by the resolver (the Phase-12 WeakSet brand) and a handler has no resolver in scope,
a handler physically cannot fabricate a context for another tenant.

### The intra-tenant boundary — `Principal` + `WeddingAuthorizer`

- **The `SessionStore` is the sole mint of a `Principal`** — the auth analogue of "the resolver is the
  sole mint of a `TenantContext`". The token is a server-issued **opaque handle**, not a
  client-decodable claim, so there is no client-asserted tenant_id/role. The principal's `tenant_id`
  comes from the **resolved context**, never a slug echo.
- **The `Principal` is branded + membership-checked exactly like `TenantContext`** (a module-private
  WeakSet identity token, `assertMintedPrincipal` at the authorizer's entry). A forged `couple`
  principal naming a different `wedding_id` would be an intra-tenant escalation if the authorizer
  trusted a structural object — so the two boundaries are symmetric: neither a forged context nor a
  forged principal can cross its boundary.
- **No intra-tenant existence oracle.** A couple addressing a wedding that is not theirs is masked as a
  `404` **byte-identical** to a missing wedding. Ownership is decided **structurally from
  `principal.wedding_id`, before and independent of any repository lookup** — so "exists but not yours"
  and "doesn't exist" are one code path; even the couple's own absent id reads back the same `404`. A
  *capability* the role lacks entirely (a couple creating) is `403` (no specific resource probed). This
  carries Phase 12's inter-tenant no-oracle one layer up.
- **One code-free response policy.** `errorToResponse` is the single place codes become statuses, and
  it emits frozen, code-free constant bodies: the masked `404`, the `401`, and the `500` backstop are
  each one shared constant, so none of the distinct internal `PRODUCT.*` codes is observable. Stage
  precedence is pinned: tenant-resolve (`404`) and auth+bind (`401`) run before any `405`/route-shape
  check, so route shape is not a pre-auth oracle.
- **Login is a labeled simulation, with no existence oracle.** It requires only the tenant to be
  usable (resolved through `resolveBySlug`); it does **not** verify a real credential and does **not**
  confirm the couple's `wedding_id` — checking existence would turn the unauthenticated login endpoint
  into the loudest oracle. A phantom id is carried opaquely and surfaces only, masked, at read.

## Alternatives considered

- **A framework (Express/Fastity).** Rejected: the repo is deliberately dependency-light and offline.
  Node's built-in `http` plus a pure handler keeps zero new runtime deps and makes the keystone
  socket-free.
- **Tenant from a subdomain (`acme.example.com`).** Deferred to the UI phase. A path prefix
  (`/t/:slug/...`) is unambiguous and testable now; the slug-keyed resolver already survives either.
- **A trusting structural `Principal` (no brand).** Rejected for the same reason Phase 12 branded the
  context: the authorizer is a reusable component a future caller/test can hit with `as Principal`, and
  a forged couple principal is an intra-tenant escalation the context cannot stop.
- **Verifying the couple's `wedding_id` at login (for "internal consistency").** Rejected — it is an
  existence oracle on an unauthenticated endpoint. The opaque-carry + masked-read design is both
  consistent and oracle-free.
- **A JSON Schema for the session/principal.** Rejected: a session is transient simulated auth state,
  not a persisted aggregate — a documented TS type, so the contract manifest stays at 15 schemas.

## Consequences

- The HTTP edge inherits Phase 12's inter-tenant guarantee and adds the intra-tenant one; Phases 14–16
  build on both and may not weaken them. `/healthz` is the seam Phase-16's Docker healthcheck will use.
- **doddy re-reviewed the built code and found nothing exploitable** (no P0/P1/P2): sole context mint +
  structural handler purity, bind-before-use with no TOCTOU, byte-identical 404s with no code leak,
  body smuggling (`tenant_id`/`wedding_id`/`__proto__`) all closed, login no-oracle and tenant-bound,
  fail-closed including the socket adapter.
- **Deferred (recorded, not faked):** field-level couple write policy (a couple may not `cancel`) is a
  later refinement — Phase 13 lands resource-scoping (own-vs-foreign), not a per-field policy. Real
  credential verification, cryptographic tokens (JWT/expiry/rotation), persistence beyond in-memory,
  and slow-loris/idle timeouts are hardening for when going-live is on the table (human-reserved).
- Offline-first preserved: in-memory stores, injected clock/ids, no money/booking/comms; login is a
  labeled simulation.

See memory [[http-edge-and-intra-tenant-auth]] and [[multi-tenant-isolation-boundary]].
