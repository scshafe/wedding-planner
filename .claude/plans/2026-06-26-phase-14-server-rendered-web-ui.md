# Phase 14 — The server-rendered web UI (the themed, white-label browser surface)

## Why this, why now

Phases 12–13 built the product surface's **domain core + two stacked, unforgeable boundaries**
(inter-tenant `TenantContext`, intra-tenant `Principal`) and a **pure JSON request edge**
(`ProductApi.handle`) that cannot route around either ([[multi-tenant-isolation-boundary]],
[[http-edge-and-intra-tenant-auth]]). But nothing yet renders to a human: the surface is demoable only
with `curl`. The product arc is **12 domain core ✅ → 13 HTTP/auth ✅ → 14 web UI → 15 onboarding/billing
sim → 16 Docker image**. Phase 14 is the rung that makes the system **demoable in a browser** — a
themed, white-label console a wedding planner (and their couples) actually look at.

The load-bearing constraint (handoff + the design reviews this phase folds): the UI must introduce **NO
new way to route around the two boundaries** (it goes through `ProductApi.handle`, never the repos), and
it must not become an **injection** surface (theme/wedding fields → HTML/CSS/URL/headers) or a new
**oracle** (themed-vs-generic rendering, redirect-vs-404 status leaking tenant existence/lifecycle).

Built **offline-first**: server-rendered HTML from Node's built-in `http`, **zero new runtime deps**, no
client JavaScript at all (`script-src 'none'`), injected clock/ids, no real money/booking/comms. This
phase is **read-oriented**: planners/couples log in (the Phase-13 credential-free simulation) and **view**
their weddings, themed per tenant. HTML create/update **forms are deferred to a later phase** — the only
state-changing HTML routes are login (mints a session) and logout (clears a cookie), which keeps the new
trust surface minimal (CSRF tokens for those POSTs are an explicit going-live deferral).

## The crux: what the existing API already discloses, and what stays secret

The single most important design fact, verified against `product_api.ts`, that shapes the whole UI:

- An **active** tenant, **unauthenticated**: `GET /t/:slug/weddings` → **401**; `POST /t/:slug/sessions`
  (valid) → **201**. So **active-tenant existence is ALREADY disclosed** by the JSON API (a non-404).
- An **unknown** tenant OR a **suspended/onboarding** tenant: → **404**, byte-identical. So
  **absent ≡ suspended ≡ onboarding** is the secret the no-oracle discipline protects (you cannot tell a
  never-existed slug from an existing-but-not-usable one). This, plus **intra-tenant ownership**
  (couple-non-owned ≡ missing), are the invariants Phase 13 pinned.

Therefore the web UI's disclosure rule, matching the API exactly (no more, no less): **theme/branding is
shown iff the tenant resolves as `active`** (the same predicate `USABLE_LIFECYCLE_STATUSES = ['active']`
the resolver uses). Unknown / suspended / onboarding / malformed-slug all render **one byte-identical
generic (unthemed) 404 page**. Showing an active tenant's public brand does not exceed the API's existing
active-existence disclosure, and never distinguishes absent from suspended.

To make this divergence-proof, the UI derives existence + auth + theme from **one `api.handle()` call per
page**: the console `GET /t/:slug` calls `api.handle(GET /t/:slug/weddings)` with the cookie's token as a
Bearer, and renders **solely by the returned status**:

| `api.handle` status | meaning | UI renders |
| --- | --- | --- |
| `200` | active tenant + valid session | themed console (the weddings list / detail) |
| `401` | active tenant, no/expired/foreign session | themed **login page** (active-existence already API-disclosed) |
| `404` | unknown / suspended / onboarding / not-owned / missing | **generic 404** (no theme) |
| `403` | role lacks the capability | themed forbidden page |

The web layer makes **no independent existence decision**. Theme is read via a `ThemeResolver` whose
predicate is **identical** to the resolver's (`findBySlug` + `isUsableLifecycle`), so "theme defined" ⟺
"`api.handle` did not 404" — they cannot diverge (same store, same predicate, single-threaded).

## The design: a repo-blind HTML front door over `api.handle()`

New module `product/src/web/`. The Phase-13 JSON layer (`product_api.ts`, `api_message.ts`,
`node_server.ts`) and the **HTTP keystone are NOT touched** — the UI is strictly additive at
non-colliding paths.

### Structural boundary inheritance (the no-bypass guarantee)
`ProductWebUi` holds **only** `{ api: ProductApi, themes: ThemeResolver }`. It has no `resolver`,
`sessionStore`, or repository in scope — exactly as the Phase-13 dispatch handlers don't. Its **only**
data path is `api.handle()`; the only extra capability is `ThemeResolver`, which is **theme-only by
construction** (returns just the `theme` value object for an active tenant — no wedding reach, mirroring
the doddy-P3 reasoning behind `TenantStore.resolveSlug`, but lifecycle-gated). So the UI inherits both
boundaries structurally and cannot read a tenant's data except through the pipeline that enforces them.

### Routing (one front door, one port, no collision with the JSON API)
`ProductWebUi.handle(req: ApiRequest): HttpResult` is the single front door. It owns an **ordered,
exact-segment** HTML route table; everything else **delegates to `api.handle()`** (wrapped as a JSON
`HttpResult`), so the keystone-protected JSON paths reach the unchanged handler:

- `GET /` → landing (generic, tenant-independent).
- `GET /t/:slug` (**exactly 2 segments**) → console: list, or **detail via `?wedding=ID`** (a query
  param — `splitPath` strips the query, so this path is `/t/:slug` and never collides with the JSON
  `/t/:slug/weddings/:id`).
- `GET /t/:slug/login` → themed login form (active) / generic 404 (else).
- `POST /t/:slug/login` → process login → 303 + `Set-Cookie` (active) / generic 404 / re-render (bad).
- `POST /t/:slug/logout` → clear cookie → 303.
- **everything else** (`/healthz`, `/t/:slug/sessions`, `/t/:slug/weddings...`, 3+ segments) →
  `api.handle()` → JSON `HttpResult`. The JSON API + keystone are byte-for-byte untouched.

### Browser auth = the opaque Bearer token, carried in a cookie (no new authority)
Login `POST` → web calls `api.handle(POST /t/:slug/sessions, {role, wedding_id?})` → on `201` reads the
**opaque token** from the JSON body → `303` to `/t/<validated-slug>` + `Set-Cookie:
wp_session=<token>; HttpOnly; SameSite=Strict; Path=/t/<validated-slug>`. Authenticated GETs read the
cookie and **forward the token verbatim** as `Authorization: Bearer <token>` to `api.handle()`. The
cookie adds **no new token authority** (the token is already minted + bound by the SessionStore/pipeline);
it adds ambient-send surface, mitigated structurally by `HttpOnly` + `SameSite=Strict` + `Path` + the
API's existing **cross-tenant bind veto** (a tenant-A token replayed on tenant-B's route → `401` at
`api.handle`, never B's data — the web layer must NOT short-circuit on cookie presence; it forwards and
lets the pipeline decide). Session fixation is closed: only a fresh `201` token is ever `Set-Cookie`'d; a
client-supplied `wp_session` is never honored as a new session. The login form picks `role`
(planner/couple) + optional `wedding_id`, faithfully reflecting the **credential-free simulation**
(clearly labeled in the UI).

## The folded review findings (Step 0 — both reviewers, APPROVE-WITH-CHANGES)

`rigorous-architect` and `doddy` reviewed the design. Both APPROVE-WITH-CHANGES; the spine (repo-blind
UI, render-by-status, reuse the bind veto) is sound. Every P0/P1 is folded into the steps below:

- **[arch P0-1 / doddy P1-1, P1-2 — the oracle]** `ThemeResolver` uses `findBySlug` + `isUsableLifecycle`
  (NOT the lifecycle-blind `resolveSlug`); unknown/suspended/onboarding/malformed-slug → **one
  byte-identical generic 404**; theme shown **iff active** (justified by the API's existing
  active-existence disclosure, above). Pinned by the pre-auth equivalence keystone.
- **[doddy P0-3 — raw slug]** Validate `:slug` against `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` (after
  lowercasing) **at the web edge before ANY use** (HTML, header, cookie). Non-matching → the **same
  masked generic 404** (NOT a 400 — that would be an oracle). Headers (`Location`, `Set-Cookie`) are built
  only from the validated slug → no CRLF/attribute injection possible.
- **[doddy P0-1 — CSS]** Colors reach HTML **only** through `safeColor`, which **re-validates**
  `^#[0-9a-f]{6}$` (case-folded) at render time and falls back to a **neutral constant** — never trusting
  the stored value. Injected only as a CSS **custom property in a quoted `style` attribute**
  (`style="--brand:#xxxxxx;--accent:#yyyyyy"`), never into `<style>` text content. The `<style>` block is
  static and references `var(--brand)`.
- **[doddy P0-2 — URL]** `logo_ref` is a free string → rendered as **opaque escaped text only**, never
  into a `src`/`href`/`url()`. No `javascript:`/`data:` reachable.
- **[arch P1-3 / doddy P2-2 — escaping]** The **only** way to build HTML is the `html` tagged template,
  which escapes **every** interpolation (`& < > " '`); **no `unsafeHtml`/raw bypass exists**. All
  attributes in templates are **quoted** (no unquoted-attribute breakout). XSS corpus pinned.
- **[arch P0-2 — themed shell]** Theme is read only on the `200`/`401` paths (both active-only); `404`
  renders a tenant-independent constant that never consults `ThemeResolver`.
- **[arch P0-3 / doddy P1-4 — cookie]** `HttpOnly`+`SameSite=Strict`+`Path` are **load-bearing, not
  cosmetic**; `Path=/t/<slug>` does not match sibling-prefix `/t/<slug>team` (cookie path-matching rules),
  and the bind veto is the real guard regardless. Forward verbatim; no short-circuit.
- **[arch P1-1 — routing]** Ordered exact-segment table; API paths reach `api.handle()` unshadowed.
  Routing test pins `/t/:slug/weddings/:id` still hits the JSON handler.
- **[doddy P1-3 — detail mask]** `?wedding=` is routed only into `api.handle()` as the path id and
  **escaped** everywhere in HTML; the not-found detail page is a **constant** that does **not reflect** the
  id, so `?wedding=<foreign>` ≡ `?wedding=<missing-own>` ≡ `?wedding=<garbage>`.
- **[doddy P2-1/P2-5 — headers/errors]** Every HTML response sets `Content-Type: text/html;
  charset=utf-8`, `X-Content-Type-Options: nosniff`, and a strict **CSP** (`default-src 'self';
  script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action
  'self'`). The web layer's own exceptions render a **constant** error page — no stack, no `PRODUCT.*`
  code leak (mirrors `RESP_INTERNAL`).

## Steps

- [x] **Step 0 — Design reviews (architect + doddy lenses).** DONE in this run: both APPROVE-WITH-CHANGES;
      all P0/P1 folded above and into the steps below. (Personas routed through `general-purpose` agents —
      the named sub-agents aren't provisioned here.)

- [x] **Step 1 — `web/html.ts`: the escaping primitives (the whole-ballgame for injection).**
      `escapeHtml(s)` (`& < > " '`); the `html` tagged template that escapes **every** interpolation, with
      **no raw bypass**; `safeColor(s)` (render-time re-validate `^#[0-9a-f]{6}$` case-folded → neutral
      constant fallback); `normalizeSlugForRoute(s)` / `isValidSlug(s)` (lowercase + the schema pattern).
      Unit tests: the XSS corpus (`</style><script>`, `"><img onerror=…>`, `javascript:…`, `data:…`,
      unquoted-attribute breakout, `%0d%0a…`), `safeColor` rejects CSS metachars, slug validator rejects
      CRLF/`..%2f`/non-pattern. **Verify green; commit.**

- [x] **Step 2 — `web/web_response.ts` + `web/theme_resolver.ts`.** `HttpResult { status, headers, body }`
      + helpers: `htmlResult(status, body)` (stamps the security headers + CSP), `redirect(status,
      location)` (location built only from a validated slug), `jsonResultFrom(ApiResponse)` (wraps the
      JSON API response — `JSON.stringify` + `application/json`), and the **constant** `GENERIC_404` /
      `ERROR_500` results. `ThemeResolver.resolveActiveTheme(slug): Theme | undefined` over `TenantStore`
      (`findBySlug` + `isUsableLifecycle`; theme-only return). Tests: headers present on every html result;
      `resolveActiveTheme` returns undefined for unknown/onboarding/suspended, the theme for active.
      **Verify green; commit.**

- [x] **Step 3 — `web/pages.ts`: the pure render functions.** `renderLanding()`, `renderLogin(theme,
      slug)`, `renderConsole(theme, slug, weddings)`, `renderDetail(theme, slug, wedding)`,
      `renderForbidden(theme)`, and the constants behind `GENERIC_404`/`ERROR_500`. All built via the
      `html` template; colors via `safeColor` into the `style` custom-property attribute; `logo_ref` +
      `couple_display_name` + ids as escaped text; the credential-free login form labeled a simulation.
      Tests: the injection corpus on `brand_name`/`logo_ref`/`couple_display_name`/`slug`/`wedding_id`
      asserts **no live markup** in the bytes; the generic 404 is tenant-independent. **Verify green;
      commit.**

- [x] **Step 4 — `web/product_web_ui.ts`: the front door.** The ordered exact-segment router; slug
      validation at the edge (→ generic 404 on miss); cookie parse (`wp_session`) → Bearer forward;
      per-page `api.handle()` call; status-driven rendering (the table above); login/logout (urlencoded
      form parse → JSON for `api.handle`; `Set-Cookie`/`303` from the validated slug); delegation of all
      non-UI paths to `api.handle()` via `jsonResultFrom`. Export from the barrel. Unit tests against
      `handle()` (no sockets): each route + status branch, cookie round-trip, the delegation passthrough.
      **Verify green; commit.**

- [x] **Step 5 — `web/web_server.ts`: the combined Node adapter.** `createProductWebUiServer(webUi)` —
      sockets → `ApiRequest` (lowercased headers, raw body, the `MAX_BODY_BYTES` cap reused) →
      `webUi.handle` → write `HttpResult` (status + headers + string body). Leaves `node_server.ts`
      (the JSON-only adapter + its integration test) untouched. Ephemeral-port integration test: `GET /`,
      a full themed login → console round-trip, an unknown-slug generic 404, and a JSON-path passthrough
      (`/healthz`, `/t/:slug/weddings` 401). **Verify green; commit.**

- [x] **Step 6 — THE WEB KEYSTONE (`product/tests/web/product_web_ui_keystone.test.ts`).** Against the
      pure `ProductWebUi.handle()`. Pins, non-regressably:
      (1) **pre-auth equivalence** — unauthenticated `GET /t/:slug` to {active≠}, {suspended}, {onboarding},
          {unknown}, {malformed-slug}: suspended ≡ onboarding ≡ unknown ≡ malformed are **byte-identical**
          generic 404; active is a distinct themed login (matching the API's 401-vs-404 line, no more);
      (2) **injection corpus** — brand/logo/couple-name/slug/`?wedding=` payloads escaped in body + **no
          header injection** (`Location`/`Set-Cookie` clean);
      (3) **masked detail** — couple, `?wedding=<foreign>` ≡ `<missing-own>` ≡ `<garbage>`, id not reflected;
      (4) **the deputy / cross-tenant replay** — a token minted at `/t/alpha/login`, replayed (cookie or
          Bearer) at `/t/beta/...`, yields masked output, never beta's data (re-proves the bind veto through
          the web layer);
      (5) **routing** — `/t/:slug/weddings/:id` still reaches the unchanged JSON handler (not UI-shadowed);
      (6) **`safeColor` render-time** — a stored non-`#hex6` color → neutral fallback, no CSS metachar survives.
      **Verify green; commit.**

- [x] **Step 7 — Built-code re-review (architect + doddy lenses); fold findings.** Re-run both persona
      lenses on the built UI (escaping completeness, the oracle equivalence, header construction, the cookie
      flow). Apply anything material; re-verify green; commit.

- [x] **Step 8 — ADR 0014 + memory + README + handoff.** ADR `docs/adr/0014` (the web edge: theme-iff-active
      disclosure equivalence, the four-context encoders, the cookie-as-Bearer transport); memory
      `[[web-ui-themed-edge]]` + index it in `MEMORY.md`; update root + `product/README.md`; update
      `.claude/handoff.local.md` (Phase 14 built; next = Phase 15 onboarding/billing sim). Commit.

## Invariants to carry forward (do not weaken)
- **Theme iff active**, and **absent ≡ suspended ≡ onboarding** is byte-identical generic 404. The web
  layer makes no independent existence decision — status from `api.handle()` drives everything; theme's
  predicate is identical to the resolver's.
- **Four injection contexts, four encoders:** HTML text (the `html` template), CSS color (`safeColor`
  render-time revalidation → custom-property attribute only), URL (`logo_ref` as opaque text, never a
  scheme), and headers (built only from the validated slug). One text escaper is **not** sufficient.
- **The cookie is transport for the opaque Bearer token, nothing more** — forwarded verbatim, never
  short-circuited; the cross-tenant bind veto in `api.handle` is the real guard.
- **The JSON layer + HTTP keystone stay byte-for-byte untouched.** The UI is additive at non-colliding
  paths; `node_server.ts` is not folded into the web server.
- **No client JavaScript this phase** (`script-src 'none'`) — defense-in-depth even if an escaper is missed.
- HTML create/update **forms + their CSRF tokens** are the next-phase deferral; this phase is read + the
  two minimal-surface POSTs (login/logout).
