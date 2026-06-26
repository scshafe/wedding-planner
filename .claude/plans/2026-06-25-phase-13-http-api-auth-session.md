# Phase 13 — The HTTP API + simulated auth/session (the intra-tenant boundary)

## Why this, why now

Phase 12 opened the customer-facing product surface with the multi-tenant **domain core** and the
**inter-tenant isolation boundary** ([[multi-tenant-isolation-boundary]]) — proven, by construction,
that a `TenantContext` for tenant A can never read/list/write tenant B's data. But the boundary lives
at the *domain* layer; nothing yet drives it from a request, and Phase 12 deliberately deferred the
*intra-tenant* authorization boundary (planner vs couple). The handoff ranks **the HTTP API +
simulated auth/session** the #1 strategic lever: it is the transport layer that turns the domain core
into something demoable, and it is where the second boundary lands.

This is the natural next rung of the product arc (12 domain core ✅ → **13 HTTP/auth** → 14 web UI →
15 onboarding/billing sim → 16 Docker image), and it is the right time because every subsequent phase
(UI, onboarding, Docker) needs a request edge that *cannot route around* tenant isolation. Establish
that edge now, prove it with an HTTP-level adversarial keystone, and Phases 14–16 inherit a boundary
they cannot bypass — the same "prove the invariant at the seam, then build on it" discipline every
prior phase used.

Built **offline-first** (Node's built-in `http`, zero new runtime deps, no network egress, injected
clock/ids, no real money/booking/comms). Login/session are **simulated** (no real credentials —
clearly labeled; real credential verification is a Phase-15 onboarding / human-reserved concern).

## The design: two stacked boundaries, one request pipeline

The product surface now enforces **two** boundaries, stacked:

1. **Inter-tenant** (inherited from Phase 12, by construction): every request resolves **exactly one**
   `TenantContext` at the routing edge; the partition is always selected by that context; no handler
   ever names a `tenant_id`.
2. **Intra-tenant** (NEW this phase): a `Principal` — `planner` (the tenant's staff; sees the whole
   tenant) vs `couple` (bound to **exactly one** `wedding_id`; sees only their own wedding). This is
   the finer-grained authorization gate Phase 12 left for Phase 13.

### The request pipeline — the seam that cannot route around isolation

A request flows through ordered stages; a route handler at the end only ever receives
already-resolved, already-authorized values. **The context is minted exactly once, at stage 2, by the
resolver; the principal is bound to that context at stage 4; no handler constructs a `tenant_id` or a
context.** This is made **structural, not prose** (arch P1-A): the pipeline (stages 1–4) is the only
code that holds the `resolver` and `sessionStore`; route handlers are passed a **narrow deps bag of
just `{ weddings, authorizer }`** and the three resolved values `(context, principal, request)` — they
*cannot* mint a context or resolve a session because neither is in their lexical scope. A structural
test pins that the handler deps type excludes the resolver/sessionStore.

1. **Parse** — method, path, headers, JSON body (malformed JSON → `400`).
2. **Resolve tenant** — extract the slug from the route (path prefix `/t/:slug/...` — unambiguous and
   testable; subdomain extraction is the white-label-realistic variant, deferred to the UI phase).
   `resolver.resolveBySlug(slug)` → `TenantContext`. **The sole per-request mint.** Unknown/unusable →
   mapped to `404` (see status map; a suspended tenant is indistinguishable from an absent one).
3. **Authenticate** — extract the session token (`Authorization: Bearer <token>`).
   `sessionStore.resolve(token)` → `Principal`. No/unknown token → `PRODUCT.NO_SESSION` → `401`.
4. **Bind the session to the tenant (cross-tenant replay veto)** — assert
   `principal.tenant_id === context.tenant_id`. A session minted under tenant A, presented on tenant
   B's route, is **rejected** (`PRODUCT.SESSION_TENANT_MISMATCH` → `401`) — NOT silently re-scoped to
   A, NOT honored against B. This is the new HTTP-edge keystone case.
5. **Authorize + dispatch** — the route handler applies the `WeddingAuthorizer` to gate the specific
   operation, then calls the Phase-12 repository **with the context** (never a raw tenant_id).

### The Principal / session model (the second "sole mint")

```ts
type PrincipalRole = 'planner' | 'couple'
interface Principal {
  readonly tenant_id: string
  readonly role: PrincipalRole
  readonly wedding_id?: string   // present iff role==='couple' — the single wedding they're bound to
  readonly principal_id: string
}
```

- **The `SessionStore` is the sole mint of a `Principal`** — mirroring "the resolver is the sole mint
  of a `TenantContext`". A simulated, clearly-labeled `login(...)` issues a server-side opaque token
  (injected id) and stores the principal; `resolve(token)` returns the stored principal or `undefined`.
  The token is a **server-issued opaque handle**, not a client-decodable claim — the store is the
  authority, so there is **no client-asserted tenant_id / role** (the auth analogue of "no
  client-asserted partition key"). Backing map is `#`-private. The principal's `tenant_id` is taken
  from the **resolved `TenantContext.tenant_id`** at login (NOT echoed from the raw `:slug`), so a
  session's tenant can never disagree with a real resolved tenant (doddy P2).
- **Login does NOT verify a couple's `wedding_id` exists** (doddy P0 / arch P3-C — the loudest oracle).
  An earlier draft had couple-login require the named `wedding_id` to exist in the tenant; that turns
  the *unauthenticated* login endpoint into an intra-tenant existence oracle (probe which wedding_ids
  exist by watching login succeed/fail). Instead login only requires the **tenant** to be usable; the
  couple's `wedding_id` is carried **opaquely** into the principal. A phantom or foreign `wedding_id`
  buys nothing — it simply reads back the same masked `404` as any non-owned id at *use*, where the
  no-oracle masking already lives. Login carries no existence signal at all.
- **The cached `wedding_id` is bounded-residual safe** (arch P2-B). Phase 12's lesson: a context caches
  no lifecycle authority. The couple principal caches `wedding_id` from login — acceptable here because
  weddings are **never deleted or reassigned** (no such op exists; `create` mints a fresh id, `update`
  cannot change `wedding_id` or `tenant_id`), so the binding cannot go stale. Documented as a named
  bounded residual; if a delete/reassign ever lands, the authorizer must re-resolve ownership at use.
- **The `Principal` is branded + membership-checked, exactly like `TenantContext`** (a module-private
  `WeakSet` identity token; `assertMintedPrincipal` at the authorizer's entry). The threat is the same
  one doddy proved for the context: the authorizer is a reusable component that future code / tests can
  call with a hand-built `as Principal`; a forged `couple` principal naming a different `wedding_id`
  would be an intra-tenant escalation if the authorizer trusted any structural object. Branding makes
  the two boundaries symmetric: **neither a forged context nor a forged principal can cross its
  boundary.** (Defense in depth: even a forged principal cannot cross *tenants* — the context still
  governs partitioning — but it could cross *weddings within a tenant*, so the brand is load-bearing
  for the intra-tenant gate specifically.)
- **Login is a simulation, honest about it, with no existence oracle.** It requires only the **tenant**
  to exist+usable (resolved through `resolveBySlug`, so a suspended tenant fails with the same `404` as
  an absent one). It does **not** verify a real credential and does **not** confirm the couple's
  `wedding_id` (see above — that would be an oracle). Real credential verification is human-reserved /
  Phase-15. Labeled in code and ADR.

### The `WeddingAuthorizer` — intra-tenant rules + the no-oracle masking (the load-bearing design)

The central intra-tenant insight (the doddy lens, carried from Phase 12's no-existence-oracle):
**a couple requesting a wedding that is not theirs must be indistinguishable from a missing wedding —
`404`, byte-identical, NOT `403`.** Revealing "exists but not yours" is an *intra-tenant* existence
oracle, the same failure Phase 12 closed *inter-tenant*. So the authorizer distinguishes two kinds of
denial, principled:

- **Resource-scoped denial** (couple → a specific *foreign-but-same-tenant* wedding): mapped to the
  **same `404`** as a genuinely missing wedding, with a **byte-identical body** — no existence oracle.
- **Capability denial** (couple → `create`, which *no* couple can ever do, independent of any specific
  resource): `403 FORBIDDEN` — no oracle concern, because no specific resource is being probed.

Rules:

| op | planner | couple |
| --- | --- | --- |
| `list` weddings | all in tenant | narrowed to their own wedding (a zero-or-one list — **not** a 403) |
| `read` wedding X | any in tenant | own → record; non-owned → identical `404` (no repo lookup for non-owned) |
| `create` wedding | yes | `403` (capability denial) |
| `update` wedding X | any in tenant | own → ok; non-owned → identical `404` (no repo lookup for non-owned) |

**The load-bearing ordering (doddy P0 / arch P1-B): for a couple, ownership is decided STRUCTURALLY
from `principal.wedding_id`, before and independent of any repository lookup.** Any id `X !==
principal.wedding_id` yields the masked not-found outcome *without the handler ever asking the repo
whether `X` exists* — so "exists but not yours" and "doesn't exist" are the same code path. Crucially
this also means a couple's **own** id that is genuinely absent (a phantom `wedding_id` carried from
login, or a never-created id) reads back the **byte-identical** `404` — masking holds from the
couple's-own-missing direction too, not just the foreign-exists direction. Only after the structural
ownership check passes does the handler call `repo.get(ctx, principal.wedding_id)` (which may itself be
`undefined` → the same `404`).

**Couple `list` reuses the read path, never a post-hoc filter** (arch P2-D / doddy P1): it returns
`[theBoundWedding]` or `[]` derived **only** from `principal.wedding_id` — it never pulls the tenant
partition into the handler (no defense-in-depth regression; no tenant-cardinality leak).

**Authorization precedes body validation** (arch P1-B): for `update`, the couple ownership decision and
the masked `404` are computed *before* the request body is validated, so a malformed body on a
non-owned id cannot surface a `400` that distinguishes it from a missing id.

Field-level couple restrictions (e.g. a couple may not flip `status` to `cancelled`) are **noted as a
later refinement**, not built here — Phase 13 lands the resource-scoping boundary, not a full field
policy. The authorizer is **pure**, asserts `assertMintedPrincipal` at entry, and is unit-tested in
isolation; the no-oracle masking is pinned by the keystone.

### Error → HTTP status mapping (one central place, fail-closed)

A single `errorToResponse` maps `PRODUCT.*` codes to statuses so the policy lives in exactly one spot:

| code / condition | status | rationale |
| --- | --- | --- |
| `UNKNOWN_TENANT` / `TENANT_NOT_USABLE` | `404` | no usable-vs-suspended-vs-absent oracle for the transacting path (slug *presence* stays the Phase-12 named residual, but the API does not confirm lifecycle) |
| `NO_SESSION` / `SESSION_TENANT_MISMATCH` | `401` | unauthenticated *for this tenant*; a mismatch never confirms the session is valid elsewhere |
| `FORBIDDEN` | `403` | capability denial (no resource probed) |
| resource not found / couple-foreign (masked) | `404` | **byte-identical** for missing and foreign — no intra-tenant oracle |
| malformed JSON / `VALIDATION_FAILED` (bad body) | `400` | client error |
| route unknown | `404`; method not allowed | `405` |
| `FORGED_CONTEXT` / `FORGED_PRINCIPAL` / `CROSS_TENANT_WRITE` | `500` | an internal invariant violation — a real request can never construct these (the handler omits `tenant_id`/`wedding_id` from bodies and derives them from the context/route); reaching one is a *bug*, surfaced as 500, never a normal client path |

**Response bodies for every error are code-free and context-free** (arch P1-C / doddy P1). A masked
`404` is a **single frozen constant** (`{ error: 'not_found' }`) shared by missing-id, couple-non-owned,
unknown-tenant, and unknown-route — they are byte-identical, so none of the distinct internal
`PRODUCT.*` codes is observable (the keystone compares the masked-foreign body against *both* the
missing-id body and the unknown-route body). Likewise `401` is one constant, and the `500` backstop is
one constant — `errorToResponse` **never** echoes `error.code` or `error.context` to the client.

**Stage precedence is pinned so route/method shape is not a pre-auth oracle** (doddy P1): on a
tenant-scoped path, tenant-resolve (→ `404`) and authenticate+bind (→ `401`) run **before** any
method-allowed (`405`) or route-shape distinction. An unauthenticated wrong-method request to a tenant
route yields `401`/`404`, never `405`.

The create/update **bodies carry NO `tenant_id` and NO `wedding_id`** — the handler derives ownership
from the context and identity from the route, so a client cannot even *attempt* a cross-tenant write
through the API (`CROSS_TENANT_WRITE` becomes a pure internal backstop). Bodies are hardened against
smuggling (doddy P1): the handler **extracts named fields explicitly** (never a blind `{...body}`
spread of attacker JSON), **rejects/strips `__proto__`/`constructor`/`prototype` keys**, applies the
route `wedding_id` and the context `tenant_id` **last**, and relies on the wedding schema's
`additionalProperties:false` (confirmed present) as the final backstop against any extra field.

### Endpoints (minimal, REST, tenant-prefixed)

- `GET  /healthz` — unauthenticated, no tenant; `200` with a **constant** `{ status: 'ok' }` (leaks no
  tenant count / store internals — arch P3-B); the seam Phase-16's Docker healthcheck will use.
- `POST /t/:slug/sessions` — **simulated login.** Body `{ role, wedding_id? }` → `{ token, principal }`.
- `GET  /t/:slug/weddings` — list (narrowed by principal).
- `POST /t/:slug/weddings` — create (planner only). Body `{ couple_display_name, event_date, status? }`.
- `GET  /t/:slug/weddings/:weddingId` — read (planner any; couple own-or-`404`).
- `PUT  /t/:slug/weddings/:weddingId` — update (planner any; couple own-or-`404`). Body = wedding
  fields (no `tenant_id`/`wedding_id`); handler reconstructs `{...existing, ...patch, tenant_id: ctx, wedding_id: route}`.

### Layering / files (transport depends on domain, never the reverse)

```
product/src/auth/principal.ts            @canonical principal — Principal type + role; WeakSet brand + assertMintedPrincipal
product/src/auth/session_store.ts        @canonical session_store — sole mint (login) + resolve(token); #-private map; injected ids
product/src/auth/wedding_authorizer.ts   @canonical wedding_authorizer — pure intra-tenant rules + no-oracle masking
product/src/http/api_message.ts          ApiRequest / ApiResponse value types (transport-agnostic)
product/src/http/product_api.ts          @canonical product_api — the pure handler: the 5-stage pipeline + errorToResponse + routes
product/src/http/node_server.ts          @canonical product_api_server — thin Node http adapter: createProductApiServer(deps) -> http.Server
```

The domain layer (`tenant/`, `wedding/`) is **not modified** and gains **no import** of the http/auth
layer. New `PRODUCT.*` codes are documented in `product_error.ts`.

## How it fits the one safety model (not a parallel one)

- **The intra-tenant gate reuses the same firewall shape**: sole-mint principal (← sole-mint context),
  brand + membership check (← the WeakSet token), **no existence oracle** (the couple-foreign `404`
  mask ← the inter-tenant `undefined`), fail-closed (no/forged session → `401`, suspended tenant →
  `404`). Same model, finer surface — not a second one.
- **Offline-first preserved.** Node `http` only; no network egress beyond a locally-bound port in the
  one adapter integration test; no money/booking/comms; login is a labeled simulation.
- **Going live stays human-reserved.** Producing the request edge is in scope; running it for real
  (hosting, DNS, real tenants/credentials/payments) is the human crossing — not simulated here.
- **Contracts-as-source-of-truth.** The wedding/tenant aggregates keep their Phase-12 JSON Schemas; the
  *session/principal* is **transient simulated auth state, not a persisted aggregate**, so it is a
  documented TS type, not a 16th schema (recorded in "Out of scope", with rationale).

## Steps

- [x] **Step 0 — Design reviews folded.** Ran the `rigorous-architect` and `doddy` (trust-boundary)
  lenses over this plan *before building* (via `general-purpose` agents carrying the persona, per the
  handoff note that the named sub-agents aren't provisioned here). Both **APPROVE-WITH-CHANGES**; all
  findings folded into the design above and Steps 1–5: handler purity made structural via a narrow
  `{weddings,authorizer}` deps bag (arch P1-A); couple ownership decided **structurally before any repo
  lookup**, masking holds from the own-missing direction too (doddy P0 / arch P1-B); **dropped the
  couple-login wedding-existence precondition** — the loudest oracle (doddy P0 / arch P3-C); single
  code-free constant `404`/`401`/`500` bodies (arch P1-C / doddy P1); `401`/`404` precede `405` (doddy
  P1); body-smuggling hardening — explicit field extraction + `__proto__` strip + `additionalProperties:false`
  (doddy P1); principal `tenant_id` from the resolved context not the slug (doddy P2); couple `list`
  reuses the read path, zero-or-one (arch P2-D / doddy P1); cached `wedding_id` documented as a bounded
  residual (arch P2-B); Principal branded by a **WeakSet membership token** not a symbol property (arch
  P2-A); `/healthz` constant body (arch P3-B). _(Documentation-only; tick on commit.)_

- [ ] **Step 1 — The auth core (principal + session + error codes).**
  - `product/src/auth/principal.ts` (`@canonical principal`) — the `Principal` type + `PrincipalRole`,
    the module-private `WeakSet` brand, `assertMintedPrincipal` (`PRODUCT.FORGED_PRINCIPAL`), and the
    sole internal `mintPrincipal` (frozen). The brand symbol/mint are NOT exported from the barrel.
  - `product/src/auth/session_store.ts` (`@canonical session_store`) — `SessionStore`: `login(ctx, who)`
    (the sole mint; takes a *resolved* `TenantContext` so the principal's `tenant_id` is the context's,
    not a raw slug; does NOT verify the couple's `wedding_id` — no oracle; issues an injected-id opaque
    token), `resolve(token) -> Principal | undefined`; `#`-private token→principal map. Injected ids.
  - Add `PRODUCT.NO_SESSION`, `PRODUCT.SESSION_TENANT_MISMATCH`, `PRODUCT.FORBIDDEN`,
    `PRODUCT.FORGED_PRINCIPAL`, `PRODUCT.BAD_REQUEST`, `PRODUCT.ROUTE_NOT_FOUND`,
    `PRODUCT.METHOD_NOT_ALLOWED` to `product_error.ts`'s documented code list.
  - Barrel: export `SessionStore`, `type Principal`, `type PrincipalRole`, `assertMintedPrincipal`
    (NOT the brand/mint). Happy-path unit tests. Green.

- [ ] **Step 2 — The `WeddingAuthorizer` (intra-tenant rules + no-oracle masking).**
  `product/src/auth/wedding_authorizer.ts` (`@canonical wedding_authorizer`) — a pure authorizer that,
  given a (branded) `Principal`, decides each op and applies the **resource-scoped→`404`-mask vs
  capability→`403`** distinction. **Couple ownership is decided structurally from `principal.wedding_id`
  before any repo lookup** (a non-owned id → the masked decision with no existence probe). It asserts
  `assertMintedPrincipal` at entry. Returns a decision value (`allow` / `mask-not-found` / `forbidden`),
  never throws for an authz outcome (so the masked path can never trip the `500` backstop). Unit tests
  cover: planner full access; couple read/update own → allow; couple read/update **non-owned (foreign
  AND own-but-absent)** → the identical masked decision (NOT forbidden); couple create → forbidden;
  couple list → zero-or-one from `wedding_id` only; a forged (unbranded) principal → `PRODUCT.FORGED_PRINCIPAL`. Green.

- [ ] **Step 3 — The pure HTTP handler + endpoints.**
  - `product/src/http/api_message.ts` — `ApiRequest` (method, path, headers, parsed body) and
    `ApiResponse` (status, JSON body) value types; transport-agnostic, no Node coupling.
  - `product/src/http/product_api.ts` (`@canonical product_api`) — `ProductApi.handle(req): ApiResponse`
    running the 5-stage pipeline (parse → resolve tenant → authenticate → bind → authorize+dispatch),
    the route table (`/healthz`, `/t/:slug/sessions`, `/t/:slug/weddings[/:id]`), and the central
    `errorToResponse`. The pipeline holds `{ resolver, sessionStore }`; route handlers receive only
    `(ctx, principal, req)` + a narrow `{ weddings, authorizer }` deps bag (arch P1-A — structural
    handler purity, pinned by a test). `errorToResponse` emits **code-free constant** bodies; the
    masked `404`, `401`, and `500` are each one frozen constant. Stage precedence: tenant-resolve /
    auth+bind run before any `405`/route-shape check on tenant routes. Bodies: explicit field
    extraction, `__proto__`/`constructor` stripped, route `wedding_id` + context `tenant_id` applied
    last. Handler-level tests for each endpoint's happy path + the full status map. Green.

- [ ] **Step 4 — The Node `http` adapter.**
  `product/src/http/node_server.ts` (`@canonical product_api_server`) — `createProductApiServer(deps)`
  returns an `http.Server` that reads the body, builds an `ApiRequest`, calls `ProductApi.handle`, and
  writes the `ApiResponse` (status + JSON). One integration test boots it on an **ephemeral port**
  (`listen(0)`), issues real requests (`fetch`/`http`), asserts `/healthz` + a tenant round-trip, then
  closes. Injected clock/ids throughout. Green.

- [ ] **Step 5 — The HTTP keystone (the load-bearing intra-tenant + edge regression).**
  `product/tests/http/product_api_keystone.test.ts` — adversarial, against the pure handler (fast,
  deterministic). With two tenants A/B and planner+couple sessions in each, assert:
  (a) **cross-tenant routing read** — a session for A's planner on `/t/<B>/weddings/<id>` cannot read
  B's wedding (tenant resolved from the *route*, the session bound to it → `401` mismatch, never B's
  data); (b) **cross-tenant session replay** — A's token presented on B's route → `401`
  `SESSION_TENANT_MISMATCH`, not silently scoped to A, never dispatched into B; (c) **intra-tenant
  no-oracle (all directions)** — a couple reading a *foreign-but-same-tenant* wedding, their
  *own-but-absent* `wedding_id`, a genuinely *missing* id, and an *unknown route* all return a `404`
  whose body is **byte-identical** (`expect(foreign).toEqual(missing)`, `.toEqual(ownAbsent)`,
  `.toEqual(unknownRoute)`) — covering GET **and** PUT; (d) **capability denial** — a couple `POST
  /weddings` → `403` (distinct from the `404` mask, and never a `500`); (e) **couple list is narrowed** —
  zero-or-one (their own only), planner list is full; (f) **no/forged session** — no `Authorization`
  header → `401`; an unknown token → `401`; (g) **fail closed mid-session** — suspend a tenant after
  issuing a session; the next request → `404`; (h) **the body cannot carry a foreign `tenant_id`** — a
  create/update body with an injected `tenant_id` (and a `__proto__`-laden body) is ignored/stripped
  (ownership derived from context; the stored record is the context's tenant), proving no
  cross-tenant-write surface; (i) **wrong method, unauthenticated, on a tenant route** → `401`/`404`,
  never `405` (route shape is not a pre-auth oracle); (j) **login is not an existence oracle** —
  couple-login with a phantom `wedding_id` succeeds identically to one with a real id (the difference
  surfaces only, masked, at read).

- [ ] **Step 6 — doddy boundary re-review of the BUILT code.** Trace the real request edge: the context
  is minted exactly once (stage 2) and no handler reconstructs one; the principal is bound to the
  context before any authorization; the couple-foreign and missing paths are byte-identical (no
  status/shape/timing oracle); the login simulation cannot mint a principal for a foreign tenant or a
  phantom wedding; `errorToResponse` never leaks which `PRODUCT.*` code fired in a way that
  distinguishes masked cases. Apply findings before ticking.

- [ ] **Step 7 — ADR 0013 + memory + README + handoff.**
  `docs/adr/0013-http-api-and-intra-tenant-auth.md` (the request edge; the two stacked boundaries; the
  intra-tenant no-oracle mask; the simulated-login boundary; deferred field policy). Memory
  `http-edge-and-intra-tenant-auth.md` (+ MEMORY.md index): the 5-stage pipeline / sole-per-request
  mint, the principal sole-mint + brand, the couple-foreign-`404` mask, the cross-tenant-replay veto,
  links [[multi-tenant-isolation-boundary]] / [[prod-trusted-evidence-channel]]. Add the API row /
  status note to `product/README.md` and the root `README.md` product-surface section. Update
  `.claude/handoff.local.md`.

## Out of scope (recorded, not faked)

- **Web UI / theme rendering** — Phase 14. This phase serves JSON; the theme is data the UI will use.
- **Onboarding / billing / comms simulation logic + real credential verification** — Phase 15. Login
  here is a labeled simulation (issues a session; verifies tenant/wedding consistency, not a secret).
- **Docker packaging** — Phase 16. `/healthz` is added now as the seam the image's healthcheck will use.
- **Field-level couple write policy** (e.g. a couple may not `cancel`) — a later refinement; Phase 13
  lands the resource-scoping (own-vs-foreign) boundary, not a per-field policy.
- **A session/principal JSON Schema** — sessions are transient simulated auth state, not a persisted
  aggregate, so they are a documented TS type (the manifest stays at 15 schemas), unlike the
  tenant/wedding aggregates.
- **Persistence beyond in-memory** — the stores stay in-memory (offline, deterministic); a persistent
  impl drops in behind the same interfaces later.
- **Real auth tokens (JWT/signing/expiry/rotation)** — the token is a server-issued opaque handle into
  an in-memory store; cryptographic session tokens are a hardening concern for when going-live is on
  the table (human-reserved).
