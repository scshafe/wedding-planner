# Handoff

## Where things stand — Phase 14 (the server-rendered, themed web UI) is BUILT ✅
`.claude/plans/2026-06-26-phase-14-server-rendered-web-ui.md` is **complete — all 9 steps ticked**
(Step 0 design reviews + Steps 1–8), on branch **`build/phase-3-generalize-search`** (the open review
artifact for `main`; Phases 3–14 build on it; the loop's merge-keeper advances `main` when green).
Working tree clean. `npm run build && npm test && npm run lint` all green (**517 tests**, up from 465
at the start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases 3–14.

**What changed — the product surface got a face.** Phase 12 opened the product surface (multi-tenant
core + inter-tenant isolation), Phase 13 added the JSON request edge + intra-tenant auth. Phase 14
adds the **first human-facing rung**: a server-rendered, themed, white-label HTML console
(`product/src/web/`, `ProductWebUi` + `createProductWebUiServer`) over the SAME `api.handle()` pipeline.
Offline-first, **zero new runtime deps, no client JavaScript**. ADR `docs/adr/0014`, memory
[[web-ui-themed-edge]].

## The load-bearing insight (carry forward)
**Disclosure equivalence (theme-iff-active) — the no-oracle discipline carried into a themed HTML layer.**
The decisive verified fact: the JSON API **already discloses active-tenant existence** (unauth
`GET /t/:slug/weddings` → `401` active vs `404` unknown) while keeping **absent ≡ suspended ≡ onboarding
byte-identical** (`404`). So the secret is *absent-vs-not-usable*, not active-existence. The UI discloses
**exactly that set**:
- The UI makes **no independent existence decision**: one `api.handle()` call per page; render **by the
  returned status** (`200`→themed data, `401`→themed login, `403`→forbidden, else→a constant generic
  `404`). `ThemeResolver`'s predicate is the **identical** `isUsableLifecycle` the context resolver uses,
  so "theme defined" ⟺ "API did not 404" — they can't diverge.
- Branding shown **iff active**; unknown / suspended / onboarding / malformed-slug → **one byte-identical
  generic (unthemed) 404** (theming never becomes an absent-vs-suspended oracle).
- **Repo-blind:** `ProductWebUi` holds only `{ api, themes }`; its ONLY data path is `api.handle()` — so
  it inherits both boundaries structurally. Routing is an ordered, exact-segment table; everything but the
  UI's own routes delegates to `api.handle()`. `/t/:slug?wedding=ID` is the detail page (query stripped →
  no collision with the JSON `/t/:slug/weddings/:id`).
- **Four injection contexts, four encoders:** `html` tagged template (every interpolation escaped;
  `SafeHtml` minted only via a module-private symbol — no raw bypass); `safeColor` (render-time `#hex6`
  revalidation → neutral, into a `style` custom-property attr never `<style>` text); `logo_ref` as escaped
  text (never `src`/`href`); inbound `:slug` validated at the edge before any header/HTML use (non-match →
  the same masked `404`, never a `400`).
- The browser carries the opaque Bearer token in a `wp_session` cookie (`HttpOnly; SameSite=Strict;
  Path=/t/:slug`); forwarded **verbatim** as `Authorization: Bearer`, never short-circuited — the
  cross-tenant **bind veto** is the real guard. Header floor on every response: `charset`, `nosniff`, a
  strict CSP with `script-src 'none'`.

## Standing directional goal (human-set 2026-06-25) — the product surface arc (UNDER WAY)
Build it **offline-first, Docker-packaged, launch-ready** (onboarding/billing/comms simulated). **Going
live stays human-reserved** (real deploy/hosting/registry/DNS/secrets/tenants/money/comms = exception
#4). The planned arc (mine to revise): **12 domain core ✅ → 13 HTTP/auth ✅ → 14 web UI ✅ → 15
onboarding/billing sim → 16 Docker image**. The auto-landing tier-1 offline loop is untouched.

## What's new this phase (by step)
- **Step 0** — architect + doddy design reviews (both APPROVE-WITH-CHANGES); folded. Biggest folds: the
  disclosure-equivalence rule (theme-iff-active, matching the API's 401-vs-404 line); four-context
  encoders; inbound-slug validation at the edge; render-by-status so the UI makes no independent decision.
- **Step 1** — `web/html.ts`: the injection-safe primitives (the `html` template, `safeColor`, slug
  validation). 12 tests, the XSS corpus across four contexts.
- **Step 2** — `web/web_response.ts` (`HttpResult` + helpers, the security-header floor) + the
  lifecycle-gated `web/theme_resolver.ts`.
- **Step 3** — `web/pages.ts`: the pure themed render fns + the frozen tenant-independent GENERIC_404/ERROR_500.
- **Step 4** — `web/product_web_ui.ts`: the repo-blind front door (routing, cookie↔Bearer, render-by-status,
  delegation). Barrel exports added.
- **Step 5** — `web/web_server.ts`: the combined Node adapter (`createProductWebUiServer`) + an
  ephemeral-port integration test.
- **Step 6** — THE WEB KEYSTONE (`product/tests/web/product_web_ui_keystone.test.ts`): pre-auth
  equivalence, injection corpus (body + headers), masked detail, cross-tenant replay, JSON-path
  non-shadowing, the security-header floor.
- **Step 7** — built-code re-review (architect + doddy): **both APPROVE, nothing exploitable**. Folded:
  `SafeHtml` no-raw-bypass made structural (module-private mint symbol); `nosniff` on redirect/JSON
  results; `splitPath` de-duped to one canonical `http/path.ts`.
- **Step 8** — ADR 0014 + memory [[web-ui-themed-edge]] + MEMORY.md index + READMEs (root + product) + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **★ CONTINUE THE PRODUCT ARC — Phase 15: onboarding + billing simulation.** The natural next rung: a
  simulated onboarding flow (create a tenant + its first planner, pick a plan_tier, activate the lifecycle
  — today tenants are created directly in tests/seed) and a simulated billing surface (plan_tier →
  modeled charges; lifecycle transitions onboarding→active→suspended). All **offline** — no real money
  (CLAUDE.md rail; exception #4). This is where the `lifecycle_status` states (onboarding/suspended) the
  resolver already fails-closed on get a *driver*, and where the white-label tenant gets a self-serve
  birth instead of a test fixture. Likely needs: an onboarding HTTP/UI surface (reusing the Phase-14 web
  layer + the JSON pipeline), a billing-event model (simulated, ledger-style), and care that NOTHING
  simulates having crossed the going-live line. Write a plan (`writing-plans`); verify with doddy
  (the onboarding endpoint is a new pre-auth surface — guard it the same no-oracle way) + rigorous-architect.
- **Enrich the product domain/API instead** — before onboarding: HTML create/update forms (the Phase-14
  deferral — needs CSRF tokens, the first real mutation trust surface in the UI); a wedding↔planning-engine
  seam (link a wedding to a strategy genome / North Star — the long-promised engine↔surface connection);
  planner/couple *membership* modeling (multiple planners/couples per tenant; today a couple is a
  self-asserted login); a field-level couple write policy (the Phase-13 deferral). Lower-risk than
  onboarding, but onboarding is the higher-value arc step.
- **Earlier offline-loop levers (still open, all incremental):** enrich the advisory corpus; a 4th
  tier-1 knob → 4-D search (needs a meaningful forge-free knob, else busywork); `comms_quality`/`intuitiveness`
  rubrics (judge-shaped → STOP-and-surface, ADR 0007 — do NOT build a stub). See git history.

## Non-obvious Phase-14 context (carry forward)
- **The UI's only data path is `api.handle()`; keep it that way.** `ProductWebUi` must hold only
  `{ api, themes }`. Don't hand it a resolver/sessionStore/repository to "simplify" — that repo-blindness
  is what makes "the UI can't route around either boundary" structural. `ThemeResolver` is theme-only +
  lifecycle-gated (`findBySlug` + `isUsableLifecycle`); NEVER rebuild it on the lifecycle-blind `resolveSlug`.
- **Theme iff active; the four masked-404 cases (unknown/suspended/onboarding/malformed-slug) must stay
  byte-identical.** Render by the status `api.handle()` returns; don't add a UI-side existence check. The
  keystone's `toEqual` across those four catches any divergence.
- **All HTML through the `html` template; the four encoders are non-negotiable** (text/CSS/URL/header). A
  new dynamic value in a NEW context (e.g. a URL, an unquoted attr) needs its own encoder — the single
  text-escaper is not enough. `SafeHtml` is minted only via the module-private symbol; don't add a raw
  constructor/`unsafeHtml`.
- **The cookie is transport for the opaque Bearer token, nothing more** — forward verbatim, never
  short-circuit on its presence; the bind veto in `api.handle` is the guard.
- **The JSON layer + HTTP keystone stay byte-for-byte behavior-preserved.** `splitPath` now lives in one
  canonical `http/path.ts` used by BOTH the pipeline and the UI (so the UI can't drift from the routing it
  delegates to) — keep it that way; don't fork it.
- **Deferrals (recorded, not faked):** HTML create/update forms + their CSRF tokens; login-CSRF/logout-CSRF
  (offline-accepted, `SameSite=Strict` mitigates); TLS/CSP-tightening/rate-limits/real-creds = going-live
  hardening (human-reserved). Login is still the credential-free SIMULATION (pick a role; couple names a wedding_id).
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run
  did, for architect + doddy at design AND on the built code — both APPROVE, nothing exploitable).
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&`
  (the pipe masks the non-zero exit). Run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
- Durable facts: `MEMORY.md` index — Phase 14 added **[[web-ui-themed-edge]]**. Still load-bearing:
  [[http-edge-and-intra-tenant-auth]], [[multi-tenant-isolation-boundary]], [[prod-trusted-evidence-channel]],
  [[customer-facing-product-surface-is-a-first-class-goal]], [[agents-own-buildout-decisions]].
