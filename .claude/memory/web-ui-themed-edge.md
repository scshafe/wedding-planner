# Web UI themed edge & the disclosure-equivalence rule (Phase 14)

Phase 14 added the product surface's first human-facing rung: a server-rendered, themed, white-label HTML
console (`product/src/web/`, `ProductWebUi` + `createProductWebUiServer`) over the Phase-13 JSON pipeline.
Offline-first, **zero new runtime deps, no client JavaScript**. Read-oriented (login + view; HTML
create/update forms deferred). ADR 0014. Builds on [[http-edge-and-intra-tenant-auth]] and
[[multi-tenant-isolation-boundary]].

**The load-bearing crux — disclosure equivalence (theme-iff-active).** A themed, stateful HTML layer can
re-introduce an oracle the JSON API closed. The decisive verified fact: the JSON API **already discloses
active-tenant existence** (unauth `GET /t/:slug/weddings` → `401` active vs `404` unknown) while keeping
**absent ≡ suspended ≡ onboarding byte-identical** (`404`). So the secret is *absent-vs-not-usable*, not
active-existence. The UI discloses **exactly that set**: branding shown **iff active**; unknown / suspended
/ onboarding / malformed-slug → **one byte-identical generic (unthemed) 404**. The UI makes **no
independent existence decision** — each page issues one `api.handle()` call and renders **by the returned
status** (200→themed data, 401→themed login, 403→forbidden, else→constant 404). `ThemeResolver`'s predicate
is the **identical** `isUsableLifecycle` the context resolver uses, so "theme defined" ⟺ "API did not 404"
— they cannot diverge.

**Why:** the no-oracle discipline (Phase 12/13) protects absent-vs-suspended and intra-tenant ownership,
NOT active-existence (which the API already reveals by status). Theming active tenants is the white-label
demo value and exceeds nothing; theming a suspended/unknown tenant would manufacture the exact oracle the
lifecycle gate denies.

**How to apply (if you touch the web layer):**
- Keep the UI repo-blind: `ProductWebUi` holds only `{ api, themes }`; its ONLY data path is
  `api.handle()`. Never hand it a resolver/sessionStore/repository. `ThemeResolver` is theme-only and
  lifecycle-gated (`findBySlug` + `isUsableLifecycle`) — NOT built on the lifecycle-blind `resolveSlug`.
- **Four injection contexts, four encoders.** All HTML via the `html` tagged template (every interpolation
  escaped; `SafeHtml` minted only via a module-private symbol key — no raw bypass). Colors only via
  `safeColor` (render-time `#rrggbb` re-validation → neutral constant) into a quoted `style`
  custom-property attribute, never `<style>` text. `logo_ref` = escaped text, never `src`/`href`. The
  inbound `:slug` validated at the edge (`normalizeSlugForRoute`) BEFORE any HTML/header use; a non-match
  → the SAME masked 404 (never a distinct 400 — an oracle), so no CRLF/attribute injection reaches a
  `Location`/`Set-Cookie`.
- The browser carries the opaque Bearer token in a `wp_session` cookie (`HttpOnly; SameSite=Strict;
  Path=/t/:slug`); forward it VERBATIM as `Authorization: Bearer` and let the **cross-tenant bind veto**
  decide — never short-circuit on cookie presence. The cookie adds no new token authority.
- Routing is an ordered, exact-segment table; UI owns `/`, `/t/:slug` (2 segs), `/t/:slug/login`,
  `/t/:slug/logout`; EVERYTHING else delegates to `api.handle()`. `/t/:slug?wedding=ID` is the detail page
  (query stripped from the path → no collision with the JSON `/t/:slug/weddings/:id`). Don't re-prefix the
  JSON API or add a second port (churns the keystone / adds infra for no isolation gain).
- Every response gets the header floor: `charset=utf-8`, `nosniff`, a strict CSP with `script-src 'none'`.
- The JSON layer + HTTP keystone stay **byte-for-byte behavior-preserved**; `splitPath` is now ONE
  canonical `http/path.ts` shared by the pipeline and the UI (so the UI can't drift from the routing it
  delegates to).
- The web keystone (`product/tests/web/product_web_ui_keystone.test.ts`) pins all of the above; reverting
  any of it regresses an oracle/injection the keystone catches.

**Deferrals (next phase / going-live, human-reserved):** HTML create/update forms + their CSRF tokens;
login-CSRF/logout-CSRF (offline-accepted; `SameSite=Strict` mitigates); TLS, CSP tightening, rate-limits,
real credentials. Login is still the Phase-13 credential-free SIMULATION (pick a role; couple names a
wedding_id), clearly labeled in the UI.
