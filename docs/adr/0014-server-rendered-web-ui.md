# ADR 0014 — The server-rendered web UI: the themed white-label browser surface

- **Status:** accepted
- **Date:** 2026-06-26
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-26-phase-14-server-rendered-web-ui.md`)
- **Scope:** Phase 14 — the customer-facing product surface's first human-facing rung: a server-rendered,
  themed, white-label HTML console (`ProductWebUi`) over the Phase-13 JSON pipeline, plus a combined Node
  `http` adapter (`createProductWebUiServer`). Offline-first (zero new runtime deps, **no client
  JavaScript**, injected clock/ids). Read-oriented: planners/couples log in (the Phase-13 credential-free
  simulation) and view their weddings; HTML create/update forms are deferred. Proven by an adversarial
  web keystone.
- **Builds on** ADR 0012 (inter-tenant isolation) and ADR 0013 (the request edge + intra-tenant auth). It
  does not weaken either; it renders them to a human through the SAME `api.handle()` pipeline, adding no
  new way to route around either boundary and reusing the one safety model — not a parallel one.

## Context

After Phase 13 the product surface was complete as a JSON API but demoable only with `curl`. The product
arc (12 domain core → 13 HTTP/auth → **14 web UI** → 15 onboarding/billing → 16 Docker) needs a
browser-facing surface that a wedding planner and their couples actually look at — themed per tenant from
the white-label `theme` (brand_name, colors, logo_ref). The load-bearing risk: a themed, stateful HTML
layer can re-introduce an **oracle** (themed-vs-generic or redirect-vs-404 leaking tenant
existence/lifecycle) or an **injection** (theme/wedding/slug fields into HTML/CSS/URL/headers) that the
JSON API never had to consider — and it must not become a second path to the repositories.

## Decision

A repo-blind HTML front door that derives everything from one `api.handle()` call per page.

### The disclosure equivalence (the no-oracle crux)

The decisive, verified fact about the existing API: it **already discloses active-tenant existence** (an
unauthenticated `GET /t/:slug/weddings` is `401` for an active tenant vs `404` for unknown), while keeping
**absent ≡ suspended ≡ onboarding byte-identical** (`404`). So the secret the no-oracle discipline
protects is *absent-vs-not-usable*, not active-existence. The UI therefore discloses **exactly that set,
no more, no less**: branding is shown **iff the tenant is active**, and unknown / suspended / onboarding /
malformed-slug all render **one byte-identical generic (unthemed) 404**. Showing an active tenant's public
brand does not exceed what the API already reveals, and never distinguishes absent from suspended.

To make this divergence-proof, the UI makes **no independent existence decision**: each page issues one
`api.handle()` call and renders **by the returned status** — `200`→themed data, `401`→themed login (active,
not yet authed), `403`→themed forbidden, `404`/else→the constant generic 404. The `ThemeResolver`'s
predicate is the **identical** `isUsableLifecycle` the context resolver uses, so "theme defined" ⟺ "the API
did not 404" — they cannot diverge.

### Four injection contexts, four encoders

A single text-escaper is insufficient. All HTML is built only through the `html` tagged template (every
interpolation escaped; the `SafeHtml` it returns is minted only via a module-private symbol key — no raw
bypass). Brand **colors** reach HTML only through `safeColor`, which **re-validates `#rrggbb` at render
time** (never trusting the stored value) and falls back to a neutral constant, injected only as a CSS
custom property in a quoted `style` attribute (never `<style>` text). **`logo_ref`** (a free string) is
escaped **text only**, never a `src`/`href` (no `javascript:`/`data:`). The inbound **`:slug`** is
validated against the schema pattern **at the web edge before any HTML/header use**; a non-match takes the
same masked 404 (never a distinct 400), so no CRLF/attribute injection reaches a `Location`/`Set-Cookie`.

### Auth transport + structural no-bypass

The browser carries the opaque Phase-13 Bearer token in a `wp_session` cookie (`HttpOnly`,
`SameSite=Strict`, `Path=/t/:slug`); the UI **forwards it verbatim** as `Authorization: Bearer` and lets
the pipeline's **cross-tenant bind veto** decide — the cookie adds no new token authority and is never
short-circuited on. `ProductWebUi` holds only `{ api, themes }` (no resolver/sessionStore/repository), so
its only data path is `api.handle()`. Routing is an ordered, exact-segment table; everything but the UI's
own routes (`/`, `/t/:slug`, `/t/:slug/login`, `/t/:slug/logout`) delegates to `api.handle()`, so the
keystone-protected JSON paths reach the unchanged handler. `/t/:slug?wedding=ID` is the detail page (the
query is stripped from the path, so it never collides with the JSON `/t/:slug/weddings/:id`). Every
response carries a security-header floor (`charset=utf-8`, `nosniff`, a strict CSP with `script-src
'none'`).

## Consequences

- **The two boundaries are now demoable to a human, inherited structurally.** A planner logs in and sees
  every wedding in the workspace; a couple sees only their own; a foreign/missing wedding is a
  byte-identical masked 404; a cross-tenant cookie replay yields the other tenant's *login*, never its
  data. All themed per tenant.
- **No new trust surface beyond two minimal POSTs.** Login (mints a session) and logout (clears the
  cookie) are the only state-changing HTML routes; HTML create/update forms — and CSRF tokens for them —
  are the next-phase deferral. Login-CSRF/logout-CSRF are accepted offline (`SameSite=Strict` mitigates;
  real hardening is a going-live concern, human-reserved).
- **The JSON layer + HTTP keystone are byte-for-byte behavior-preserved.** The only shared change was
  extracting `splitPath` to one canonical `http/path.ts` (the repo's one-implementation convention),
  which both the pipeline and the UI now use, so the UI cannot drift from the routing it delegates to.
- **The web keystone** (`product/tests/web/product_web_ui_keystone.test.ts`) pins the disclosure
  equivalence, the injection corpus (body + headers), the masked-detail equivalence, the cross-tenant
  replay, the non-shadowing of the JSON path, and the security-header floor. Phases 15–16 build on this
  surface and may not weaken it.

## Alternatives considered

- **A client-side SPA.** Rejected for this rung: a build step + runtime deps + a client trust surface,
  against the offline-first, dependency-light, no-client-JS constraint. Server-rendered HTML inherits both
  boundaries with the smallest new surface; interactivity can come later.
- **Theming every surface (including pre-auth login/landing) unconditionally, or theming nothing but
  authenticated 200s.** The first leaks suspended-vs-absent (an oracle); the second discards the
  white-label demo value. The chosen **theme-iff-active** rule discloses exactly what the API already does.
- **A `/api` prefix or a separate UI port to avoid path overlap.** Rejected: re-prefixing churns the
  precious JSON keystone; a second port adds infra for no isolation gain (the boundaries live in
  `api.handle()`, not the socket). The query-param detail page + an exact-segment router avoid all
  collision on one port with zero keystone churn.
