# Product (the customer-facing surface)

The fifth domain — and the only **outward-facing** one. The four domains before it (`eval-harness/`,
`telemetry/`, `loop-orchestrator/`, `agent-operations/`) are the **engine**: how the system scores,
measures, improves, and operates *itself*. This domain is the **car**: a **white-label, multi-tenant**
web app that real wedding planners — and their couples — sign up for, theme, and use.

It is built **offline-first, as a deployable Docker container** (locally runnable, demoable,
launch-*ready*; onboarding, billing, and comms are offline simulations). **Going live stays
human-reserved** — real hosting, registry push, DNS, secrets, real tenants/payments/comms are the
human crossing (operations exception #4). Producing the image is in-scope; running it for real is not.

## The throughline: one safety model, a new surface

Multi-tenancy's load-bearing invariant is **tenant isolation** — a request carrying tenant A's
identity can never read, list, or write tenant B's data. That is the multi-tenancy analogue of the
trusted-evidence firewall (`../agent-operations/trusted_evidence_channel.md`): **wall the channel,
fail closed, no existence oracle**. It is enforced *structurally* (by construction), not by
convention:

- **The resolver is the sole mint of a `TenantContext`.** A `TenantContext` is an *unforgeable*,
  branded, frozen token. A hand-built `{ tenant_id }` object is rejected at the repository entry
  (`PRODUCT.FORGED_CONTEXT`) — "the resolver is the only mint" is a compile-time *and* runtime
  guarantee, not a code-review convention.
- **The partition key comes only from the context.** Every read/list/write is physically partitioned
  by `ctx.tenant_id`; a record's own `tenant_id` is only ever *compared* (to veto a cross-tenant
  write), never used to route.
- **No existence oracle.** A foreign-tenant id reads back the byte-identical not-found result as a
  never-existed id, via the same code path — a caller cannot distinguish "exists but not yours" from
  "doesn't exist."
- **Liveness is re-asserted at use.** A context minted while a tenant was active stops working the
  instant the tenant is suspended — liveness is checked on every operation and fails closed.

## The intra-tenant boundary (Phase 13) — planner vs couple

The Phase-12 boundary above is **inter-tenant**. Phase 13 stacks the **intra-tenant** boundary on top:
within one tenant, a `Principal` is either a `planner` (the tenant's staff — sees the whole tenant) or
a `couple` (bound to exactly one wedding — sees only their own). The request edge is a pure handler
(`ProductApi.handle: ApiRequest -> ApiResponse`) over a 5-stage pipeline — parse → resolve tenant (the
sole per-request `TenantContext` mint) → authenticate → **bind** the session to the resolved tenant
(`principal.tenant_id === context.tenant_id`, else `401` — a session for A presented on B's route is
rejected, never re-scoped) → authorize + dispatch — plus a thin Node `http` adapter
(`createProductApiServer`, the only socket-touching code). It mirrors Phase 12's discipline:

- **The `SessionStore` is the sole mint of a `Principal`** (← the resolver is the sole mint of a
  context), and the `Principal` is **branded + frozen** the same WeakSet way — a forged principal is
  rejected at the authorizer's entry (`PRODUCT.FORGED_PRINCIPAL`).
- **No intra-tenant existence oracle.** A couple addressing a wedding that is not theirs gets a `404`
  **byte-identical** to a missing one — ownership is decided structurally from the principal's bound
  `wedding_id`, *before* any repository lookup, so "exists but not yours" and "doesn't exist" are one
  path. A capability the role lacks entirely (a couple creating a wedding) is `403`.
- **Login is a labeled simulation, oracle-free.** It requires only a usable tenant; it does not verify
  a real credential and does not confirm the couple's `wedding_id` (that would be an oracle).

## The web UI (Phase 14) — the themed white-label surface

`ProductWebUi` is a server-rendered HTML front door over the SAME `api.handle()` pipeline (offline-first,
zero new deps, **no client JavaScript**; combined Node adapter `createProductWebUiServer`). It is
**repo-blind** — it holds only `{ api, themes }`, so its only data path is `api.handle()` and it inherits
both boundaries by construction. Read-oriented: log in (the credential-free simulation) and view your
weddings, themed per tenant; HTML create/update forms are deferred.

- **Disclosure equivalence (theme-iff-active).** The UI makes no independent existence decision: each page
  issues one `api.handle()` call and renders by the returned status (`200`→themed data, `401`→themed
  login, `403`→forbidden, else→a constant generic `404`). Branding is shown **iff the tenant is active**;
  unknown / suspended / onboarding / malformed-slug all render **one byte-identical generic `404`** — so
  theming never becomes an absent-vs-suspended oracle. `ThemeResolver`'s predicate is the *identical*
  `isUsableLifecycle` the context resolver uses, so theme-presence can't diverge from the API.
- **Four injection contexts, four encoders.** All HTML via the `html` tagged template (every interpolation
  escaped; `SafeHtml` minted only via a module-private symbol — no raw bypass); colors via render-time
  `safeColor` into a `style` custom-property attribute (never `<style>` text); `logo_ref` as escaped text
  (never `src`/`href`); the inbound `:slug` validated at the edge before any HTML/header use (a non-match
  → the same masked `404`, never a `400`).
- **The cookie carries the opaque Bearer token verbatim** (`wp_session`; `HttpOnly; SameSite=Strict;
  Path=/t/:slug`); the cross-tenant bind veto remains the real guard. Every response gets a header floor
  (`charset`, `nosniff`, a strict CSP with `script-src 'none'`). Proven by a web keystone.

## Status

**Phase 12 — the multi-tenant domain core:** the `tenant` + `wedding` aggregates, the white-label
`theme`, and the tenant-isolation boundary above. **Phase 13 — the HTTP request edge + simulated
auth/session:** the 5-stage pipeline, the `Principal`/`SessionStore`/`WeddingAuthorizer` intra-tenant
boundary, and the Node `http` adapter, proven by an HTTP keystone. **Phase 14 — the server-rendered web
UI:** the themed white-label HTML console over that pipeline (`ProductWebUi` + `createProductWebUiServer`),
proven by a web keystone. Pure in-memory + injected clock/ids, offline; login/session simulated.

**Later phases (the arc):** Phase 15 — onboarding + billing simulation; Phase 16 — Docker packaging → the
launch-ready image.

**Deferred (recorded, not faked):** field-level couple write policy (a couple may not `cancel`); real
credential verification, cryptographic tokens, and persistence beyond in-memory are hardening for when
going-live is on the table (human-reserved).
