# Phase 21 — Planner guest-management CRUD + the first browser-form CSRF

**Status:** IN PROGRESS — Steps 0–8 complete (749 tests green); Step 9 (docs/memory/handoff) next.
**Branch:** `build/phase-3-generalize-search` (the open review artifact for `main`; Phases 3–20 build on it; this continues it)
**Predecessor:** Phase 20 (per-message money in the North Star) — complete, 726 tests green.

## Goal

Continue the **guest-facing messaging channel** ([[guest-messaging-channel-is-a-roadmap-goal]]) — the product-surface
**operability** rung. Both human-set channel constraints are now DONE (no-vendor-lock-in: Phase 18; pricing +
North-Star scoring: Phases 18+20), so the channel's remaining work is making it **operable by a real planner**,
not new safety machinery.

Today a guest is bound to a wedding only by the **compose-time demo seed** (`GuestRegistry.register`, Phase 19) —
there is no authenticated surface for a planner to **register / list / remove** guests. This rung builds that
surface, and folds in the long-deferred **first planner *mutation* trust surface over a browser**: HTML
create/remove forms protected by **browser-form CSRF** (the anti-forgery guard Phase 19 deliberately
distinguished from the server-to-server webhook shared secret — see [[guest-messaging-inbound-edge]], which
recorded "browser-form CSRF (planner mutations) stays deferred").

Deliverables, end-to-end and offline:
- **JSON guest API** (programmatic, Bearer): `GET/POST /t/:slug/guests` + `DELETE /t/:slug/guests` — planner-only.
- **Themed HTML guest-management page** (`/t/:slug?view=guests`) with an add-guest form (wedding picker) and a
  per-guest remove form, every browser mutation carrying + verifying a **per-session CSRF token**.
- **The CSRF trust surface**: a per-session synchronizer token, **distinct from the session token**, verified
  constant-time at the **web layer** (the only place a cookie becomes a credential).

## The hard rails (unchanged — CLAUDE.md)

Offline-first. No real money / booking / comms. The product surface **imports only `@wedding-planner/shared`,
never loop/eval** (firewall by reachability; graph stays acyclic). Injected clock/ids (no ambient time/RNG).
One safety model — reuse it, never invent a parallel one. Don't modify `ops/` or `CLAUDE.md`. Push only to
`origin`. **Schema change ⇒ `npm run gen:types`.** `npm run build && npm test && npm run lint` green before
every tick/commit; build standalone (never piped — the pipe masks the non-zero exit), check `$?`. Commit per
verified step on the `build/*` branch.

## The CSRF threat model (the load-bearing reasoning — design it once, here)

**Who is the attacker?** A malicious third-party site that tricks a logged-in planner's browser into issuing a
state-changing request to our origin, riding the ambient `wp_session` cookie. The defense must make every
cookie-authenticated **mutation** require a secret the attacker cannot read or guess.

**Two structural facts make the surface small:**
1. **The cookie becomes a credential ONLY in web-owned handlers.** `ProductWebUi.#delegate` forwards a request
   to `api.handle()` **verbatim** — it does NOT translate the `wp_session` cookie into an `Authorization:
   Bearer` header. Only the web-owned handlers (`#console`, `#login`, the new `#guests`) read the cookie and
   mint a Bearer for an *internal* `api.handle()` call. Therefore a CSRF form POST aimed at a **delegated JSON
   route** (`/t/:slug/guests` POST/DELETE) arrives with **no `Authorization` header** → the JSON pipeline's
   `#authenticate` returns **401**. The JSON mutation API is **not CSRF-reachable** (a browser `<form>` cannot
   set an `Authorization` header cross-site). It needs **no** CSRF token — and gets none (Bearer clients are
   not CSRF-vulnerable by definition).
2. **The cookie is already `SameSite=Strict`**, so a compliant browser won't even attach it cross-site. That is
   the *primary* control; the synchronizer token is **defense-in-depth** (older browsers, same-site/subdomain
   vectors, and an explicit, testable in-app gate).

**So CSRF lives at exactly one layer — the web-owned form handlers — and protects exactly the browser
mutations**: `POST /t/:slug/guests/create`, `POST /t/:slug/guests/remove`, and (retrofit) `POST
/t/:slug/logout`.

**The token (synchronizer pattern), three non-negotiable properties:**
- **Per-session, server-side, minted at login** alongside the session token; verified server-side. Stateless
  double-submit is rejected — it needs a JS-readable cookie, and our `script-src 'none'` + HttpOnly model is
  stronger kept intact.
- **DISTINCT from the session token.** The session token lives in an **HttpOnly** cookie precisely so the DOM
  can't read it; embedding it as the form's `_csrf` field would write the session bearer into the page and
  defeat HttpOnly. The CSRF token is a **separate** per-session secret (its own injected id).
- **Constant-time comparison** on verify (no timing oracle on the token), fail-closed for an absent/unknown
  session (no session ⇒ `verify` is false).

**Login is exempt** (documented): there is no session yet to bind a token to. Login-CSRF ("forced login") is a
distinct, lower-severity threat mitigated by `SameSite=Strict` on the issued cookie; a pre-session token is a
later refinement, recorded as deferred — not faked.

**No-oracle on a CSRF failure:** a rejected browser mutation returns the SAME themed-403-or-`GENERIC_404` the
disclosure model already uses (theme-iff-active; unknown/suspended/onboarding/malformed-slug → the byte-identical
`GENERIC_404`). It discloses nothing beyond active-tenant existence, which is already public via theming.

## Step 0 — Design reviews (adversarial; via `general-purpose` agents — specialists are not provisioned here)

Run **two** reviews carrying the persona lens, on THIS plan, before building:
- **doddy (security / trust boundary):** Is the CSRF token genuinely unforgeable + distinct from the session
  token? Is the JSON-API "not CSRF-reachable" claim airtight (no path that translates the cookie to a Bearer on
  a delegated route)? Does the guest CRUD preserve tenant isolation + the no-existence-oracle masking? Any new
  oracle from the wedding-existence check, the duplicate-409, or the csrf-failure response? Constant-time? Any
  way a couple (or anon) reaches a planner mutation?
- **rigorous-architect (design):** Is CSRF-at-the-web-layer the right seam (vs the JSON pipeline)? Is the
  web-owned-route ↔ JSON-route split (mirroring `/login` ↔ `/sessions`) the right collision-free routing? Is the
  18th schema justified, or is the guest binding too thin to deserve a contract? Is `GuestAuthorizer` warranted
  vs a one-line role check? Does `CsrfGuard`-on-`SessionStore` violate SRP unacceptably?

Record the ratified calls + must-fixes here, fold them into the steps, then tick.

### Ratified (2026-06-27) — doddy APPROVE-WITH-CHANGES (no P0), architect APPROVE

Both reviews verified the central claim **against the code**: `#delegate` forwards verbatim (no cookie→Bearer
translation), so a cross-site form POST to the delegated JSON route arrives with **no `Authorization` header** →
401 — the JSON mutation API is genuinely **not CSRF-reachable** (the missing-Bearer 401, not SameSite, is what
stops it). The token design (distinct from the session token, server-side synchronizer, constant-time,
fail-closed) does **not** defeat HttpOnly. Routing split, tenant isolation, no-oracle masking, the 18th schema,
`GuestAuthorizer`, and `CsrfGuard`-on-`SessionStore` all ratified. Must-fixes folded into the steps:

- **[doddy P1] `verifyCsrf` ↔ Bearer binding invariant.** The session token passed to `verifyCsrf` MUST be the
  **identical** token then forwarded as the internal Bearer (no verify-A-execute-as-B). Both fail-closed branches
  — absent session, empty/non-string candidate — return false. Spec in the `CsrfGuard` doc; test both branches.
- **[doddy P1] `constantTimeEqual` length-safe + `_csrf` type guard.** No early `length !==` return (fold length
  into the accumulator / compare to fixed length); reject a non-string `form.get('_csrf')` before compare.
- **[doddy P1] Logout is routed through the SAME verify-first path** as create/remove — a forged-token logout
  returns the masked 403 and **leaves the cookie intact** (this CLOSES a current live logout-CSRF: `#logout`
  clears on ANY POST today). No unconditional-clear branch remains.
- **[doddy P2] `?view=guests` single-status masking.** Two `api.handle()` reads (guests + weddings) feed one
  page; authorize the **guests** read FIRST, and if EITHER is non-200 take `#renderNonData(status)` — never a
  half-page, never a distinguishable 200/403 split (a couple → 403 themed forbidden).
- **[doddy P2 + arch] Every `renderGuests` value flows through the `html` template** (incl. the `_csrf` hidden
  value, `recipient_ref`, and the `<select>` `wedding_id`/couple-name) — escaped text only, never `src`/`href`.
- **[doddy P2] CSRF-failure no-oracle ordering:** normalize the slug FIRST → unknown slug ⇒ `GENERIC_404` BEFORE
  any cookie read / CSRF verdict, so the CSRF outcome is never a tenant-existence oracle.
- **[arch should-fix] Rewrite the stale `@canonical product_web_ui` "Holds ONLY `{api, themes}`" line** to
  `{api, themes, csrf}` and re-state the invariant as *only-data-path-is-`api.handle()`* (csrf is an anti-forgery
  check, not a data path).
- **[arch should-fix] Generic create-result notice:** the web `/guests/create` handler maps 201 success and a
  409/400 failure to the SAME generic re-render notice (don't leak created-vs-already-registered).
- **[arch nit] `recipient_ref` `maxLength`** reuses the bound the `inbound_webhook` ref fields already use (one
  consistent opaque-ref bound, not a fresh number).

- [x] **Step 0 done:** both reviews APPROVE / APPROVE-WITH-CHANGES; every must-fix folded into the steps below.

## Step 1 — The 18th contract: the `guest` schema (+ gen:types)

A guest binding is now an **external write surface** (a planner submits it), so it earns a canonical contract
like every other product aggregate (`tenant`/`wedding`/`billing_event`/`inbound_webhook`).

- [x] `product/schemas/guest_schema.json` — `$id` `…/schemas/guest.json`; fields `tenant_id`, `recipient_ref`,
      `wedding_id`, `guest_id`, all required non-empty strings (`minLength: 1`, a sane `maxLength`).
      `recipient_ref` stays **opaque** (no carrier pattern — no `sms:`/`whatsapp:` assertion in the domain;
      just a bounded non-empty string), consistent with the port's vendor-agnostic discipline. Reuse the
      `maxLength` the `inbound_webhook` ref fields already use (one consistent opaque-ref bound).
- [x] Register it in `shared/src/contracts/contract_manifest.ts` (`ContractKey` += `'guest'`; a `CONTRACT_DEFINITIONS`
      entry under `product`). `npm run gen:types`.
- [x] Align `GuestBinding` (in `guest_registry.ts`) to the generated `Guest` type (single source of truth, the
      way `Wedding`/`Tenant` are used) — re-export/alias rather than a parallel hand-written interface.
- [x] Update the count: `shared/tests/contracts/schema_registry.test.ts` 17 → **18**; `README.md` "17 schemas" →
      "18"; `contract_manifest.ts` doc comment "17 … files" → "18".
- [x] **Gate:** build + test + lint green.

## Step 2 — `GuestRegistry` CRUD + `TenantScopedRepository.delete`

- [x] `TenantScopedRepository.delete(context, id): boolean` — `guard(context)` then `#partition?.delete(id)`;
      returns whether a record existed. (Mirrors `read`/`put`: context-keyed, no cross-tenant reach, no oracle —
      a foreign/missing id returns `false` via the same path.) Update the class doc to list `delete`.
- [x] `GuestRegistry.list(context): readonly GuestBinding[]` — delegates to `#repo.list(context)` (tenant
      partition only).
- [x] `GuestRegistry.remove(context, recipient_ref): boolean` — delegates to `#repo.delete`. **Idempotent**
      (removing an absent ref returns `false`, no throw — a trusted planner is not probed; no oracle).
- [x] `GuestRegistry.register` now **rejects a duplicate**: read-before-write within the context; an
      already-bound `recipient_ref` throws `PRODUCT.GUEST_ALREADY_REGISTERED` (prevents a silent rebind). Then
      **validate the assembled binding against the `guest` schema** (`getSchemaRegistry().assertValid<Guest>`)
      before `put` — mirrors `WeddingRepository.create`. (Compose's single demo seed is unaffected.)
- [x] Add `PRODUCT.GUEST_ALREADY_REGISTERED` to the product error space; map it → **409** in `product_api.ts`'s
      `errorToResponse`.
- [x] **Gate:** build + test + lint green; existing Phase 18/19 messaging tests still green.

## Step 3 — `GuestAuthorizer` (planner-only management)

- [x] `product/src/auth/guest_authorizer.ts` — `@canonical guest_authorizer`. `authorizeManage(principal):
      AccessDecision` → `assertMintedPrincipal`; `planner` ⇒ `allow`, else `forbidden` (a couple lacks the
      capability entirely — a 403, no resource probe, no oracle). Mirrors `WeddingAuthorizer.authorizeCreate`.
      (Couples managing their own wedding's guests is a documented future refinement, not this rung.)
- [x] **Gate:** build + test + lint green.

## Step 4 — JSON guest API (programmatic, Bearer; NOT CSRF-protected — see threat model)

- [x] `GuestHandlerDeps { registry: GuestRegistry; weddings: WeddingRepository; authorizer: GuestAuthorizer }`
      (a narrow bag, no resolver/sessionStore — structural handler purity). Add to `ProductApiDeps` as a
      **required** `guests` bag (core planner functionality, unlike the optional `messaging` channel).
- [x] Route in `#route`, in the `/t/:slug/...` branch, AFTER `weddings`: `if (segments[2] === 'guests')` →
      `#authenticate(req, context)` (stages 3–4 run before any method/shape distinction — route shape is not a
      pre-auth oracle, exactly like `weddings`) → `dispatchGuests(context, principal, req, segments,
      this.#guests)`.
- [x] `dispatchGuests` (3 segments only — no `:id` sub-path; the ref travels in the body, never the URL):
      `GET` → list, `POST` → register, `DELETE` → remove, else `methodNotAllowed()`.
  - [x] `handleGuestList` — `authorizer.authorizeManage` (forbidden ⇒ 403); `200 { guests }` (tenant partition).
  - [x] `handleGuestRegister` — authorize; `parseObjectBody`; `requireString` recipient_ref/wedding_id/guest_id;
        **verify the wedding exists in this tenant** (`deps.weddings.get(context, wedding_id)` — absent ⇒
        `RESP_NOT_FOUND`/404; the planner OWNS the workspace so disclosing in-tenant wedding existence is NOT an
        oracle — contrast login, which must NOT verify the couple's wedding_id); `registry.register` (stamps
        tenant_id from context, schema-validates, dup ⇒ 409); `201 { guest }`.
  - [x] `handleGuestRemove` — authorize; `parseObjectBody`; `requireString` recipient_ref; `registry.remove`;
        **idempotent** `200 { removed }`.
- [x] **Gate:** build + test + lint green.

## Step 5 — The CSRF guard (per-session token, distinct from the session token)

- [x] `product/src/auth/csrf_guard.ts` — the narrow `CsrfGuard` interface (`issueCsrf(sessionToken): string |
      undefined`, `verifyCsrf(sessionToken, candidate): boolean`) + a pure, **length-safe** `constantTimeEqual(a,
      b)` (no early `length !==` return; reject a non-string candidate before compare). Doc the invariants: the
      token is per-session, **distinct from the session token**, verified constant-time, **fail-closed** (absent
      session OR empty/non-string candidate ⇒ false), and **the `sessionToken` passed to `verifyCsrf` MUST be the
      identical token forwarded as the internal Bearer** (no verify-A-execute-as-B).
- [x] `SessionStore` implements `CsrfGuard`: on `login`, mint a **second** opaque id (`ids.next('csrf')`), store
      `#csrfByToken: Map<sessionToken, csrfToken>`, add `csrf_token` to the returned `Session`. `issueCsrf` looks
      it up (undefined ⇒ no session); `verifyCsrf` does the constant-time compare (false for an absent session or
      candidate). The session token NEVER appears in `#csrfByToken` values (distinctness invariant — assert it in
      a test).
- [x] **Gate:** build + test + lint green; existing session/login tests green.

## Step 6 — Web UI: the guest-management page + CSRF on every browser mutation

- [x] `ProductWebUiDeps` += `csrf: CsrfGuard`; `ProductWebUi` holds `#csrf`. (A third narrow capability beside
      `themes` — it reads NO tenant data, so the "only data path is `api.handle()`" invariant holds; CSRF is an
      anti-forgery check, not a data path.) Wire in compose (pass the `sessionStore`, typed as `CsrfGuard`).
- [ ] `pages.ts`:
  - [x] `renderGuests(theme, slug, guests, weddings, csrfToken)` — themed: a list of guests
        (recipient_ref / wedding_id / guest_id) each with an inline **remove** form (hidden `_csrf` + hidden
        `recipient_ref`); an **add-guest** form (text `recipient_ref`, a `<select>` of the tenant's `wedding_id`s
        labeled by couple name, text `guest_id`, hidden `_csrf`); a back link to `/t/:slug`. Every value flows
        through the `html` template (escaped).
  - [x] `renderConsole` — the logout form gains a hidden `_csrf`; add a "Manage guests →"
        link to `/t/:slug?view=guests`. (`renderConsole` now takes `csrfToken`.)
- [ ] `product_web_ui.ts`:
  - [x] `#console` — when `?view=guests`, render the guests page: fetch **guests FIRST** (`GET /t/:slug/guests`)
        then weddings (`GET /t/:slug/weddings`) via Bearer-from-cookie `api.handle()`; render only on **200/200**
        (resolve theme + `issueCsrf(token)` → `renderGuests`); if EITHER read is non-200 take `#renderNonData(slug,
        status)` on that status (no half-page; a couple ⇒ 403 themed forbidden from the guests read). Pass
        `csrfToken` into `renderConsole` on the plain list path too.
  - [x] New web-owned routes (distinct path names from the JSON routes — mirrors `/login` ↔ `/sessions`, so no
        collision and the delegated JSON routes stay programmatically reachable):
        `POST /t/:slug/guests/create` and `POST /t/:slug/guests/remove` (4-segment, web-owned), plus the existing
        `POST /t/:slug/logout` (now verify-first). Each handler, **in this order**: normalize the slug (unknown ⇒
        `GENERIC_404` BEFORE any cookie read — CSRF outcome is never a tenant-existence oracle) → read the session
        cookie → `parseForm` → **`#csrf.verifyCsrf(cookieToken, form.get('_csrf'))` — on failure return
        `#renderNonData(slug, 403)` with NO mutation (a forged logout therefore does NOT clear the cookie —
        closing the current live logout-CSRF)** → on success translate to an internal Bearer `api.handle()`
        (`POST`/`DELETE /t/:slug/guests`, or the cookie-clear for logout) and `redirect(303, …)`; map BOTH a 201
        success and a 400/404/409 failure on create to the SAME generic re-render notice (don't leak
        created-vs-already-registered).
  - [x] Update the `@canonical product_web_ui` doc — **rewrite the stale "Holds ONLY `{ api, themes }`" line** to
        `{ api, themes, csrf }` and re-state the invariant as *only-data-path-is-`api.handle()`* (csrf is an
        anti-forgery check, not a data path); note CSRF is enforced here (the sole cookie→Bearer seam), the JSON
        API is not CSRF-reachable, and login is the documented exemption.
- [x] **Gate:** build + test + lint green.

## Step 7 — Compose wiring

- [x] `compose.ts`: construct `GuestAuthorizer`; pass the `guests` bag to `ProductApi`; pass `csrf:
      sessionStore` to `ProductWebUi`. Keep the demo guest seed (now it's the first row a logged-in planner sees
      on the guests page). Optionally expose `guestRegistry` on `ComposedSurface` for compose-level tests.
- [x] **Gate:** build + test + lint green; the deployable wiring (Phase 16 keystone) still green.

## Step 8 — Tests (mirror source paths)

- [x] **JSON guest API** (`product/tests/http/...`): planner list/register/remove happy paths; **couple ⇒ 403**
      on every verb; **anon ⇒ 401**; **tenant isolation** (tenant A's planner never sees/removes tenant B's
      guest; cross-tenant wedding_id on register ⇒ 404); **duplicate register ⇒ 409**; **register to a
      non-existent wedding ⇒ 404**; **remove is idempotent** (absent ref ⇒ 200 `{removed:false}`); body
      smuggling (`tenant_id`/`__proto__`) closed.
- [x] **CSRF** (`product/tests/auth/csrf_guard.test.ts` + web tests): valid token ⇒ mutation proceeds; **missing
      / wrong / other-session token ⇒ 403 and NO mutation**; the CSRF token **≠** the session token; `verifyCsrf`
      fails closed for an absent session; constant-time helper behavior.
- [x] **Web flow** (`product/tests/web/...`): the guests page renders with a `_csrf` hidden field in every form;
      a forged-token POST is rejected; a valid POST forwards and 303-redirects; **csrf-failure on an unknown slug
      ⇒ `GENERIC_404`** (no oracle); the JSON `POST /t/:slug/guests` reached via `#delegate` with only a cookie
      (no Bearer) ⇒ **401** (the "JSON API not CSRF-reachable" proof).
- [x] **Gate:** full suite green (target ~+25–35 tests).

## Step 9 — Docs, memory, handoff

- [ ] **ADR 0021** — planner guest-management + the browser-form CSRF trust surface (the threat model above; the
      web-layer seam; the distinct-token rationale; login exemption; the routing split; the 18th schema).
- [ ] **Memory** `.claude/memory/planner-guest-management-and-csrf.md` (+ index it in `MEMORY.md`): the
      load-bearing invariants — CSRF at the web layer only / JSON API not CSRF-reachable / token distinct from
      session token / constant-time / no-oracle on failure / login exemption / the wedding-existence check is not
      an oracle for a planner (but is for login) / GuestRegistry CRUD inherits isolation. Link
      [[guest-messaging-inbound-edge]], [[guest-messaging-channel-is-a-roadmap-goal]], [[http-edge-and-intra-tenant-auth]].
- [ ] **Built-code adversarial re-review** (doddy + architect lenses) on the diff; apply every must-fix.
- [ ] **Handoff** `.claude/handoff.local.md`: Phase 21 complete; next levers (richer wedding-facts model;
      unify `price_book` onto the shared cost basis; couples managing their own guests; period-batched billing).
- [ ] **Gate:** build + test + lint green; commit; mark this plan COMPLETE.

## Out of scope (deferred — recorded, not faked)

- A **pre-session (login) CSRF** token — login stays exempt this rung (SameSite=Strict covers it).
- **Couples managing their own wedding's guests** (this rung is planner-only management).
- A **real provider sending real texts** — the human-reserved crossing (guest-comms tier-2), untouched.
- Guest **edit** (only create/list/remove this rung) and bulk import.
