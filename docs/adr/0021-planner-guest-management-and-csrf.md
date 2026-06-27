# ADR 0021 — Planner guest-management CRUD + the first browser-form CSRF

- **Status:** accepted
- **Date:** 2026-06-27
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-27-phase-21-planner-guest-management-and-csrf.md`)
- **Scope:** Phase 21 — the guest-messaging channel's **product-surface operability** rung
  ([[guest-messaging-channel-is-a-roadmap-goal]]). Both human-set channel constraints were already DONE
  (no-vendor-lock-in: Phase 18; pricing + North-Star scoring: Phases 18+20), so this rung adds no new safety
  machinery to the channel — it makes the channel **operable by a real planner**: an authenticated surface to
  **register / list / remove** guests, and the long-deferred **first planner *mutation* trust surface over a
  browser** — HTML forms protected by **browser-form CSRF** (the anti-forgery guard Phase 19 deliberately
  distinguished from the server-to-server webhook shared secret — [[guest-messaging-inbound-edge]]).
- **Builds on** the Phase-13 intra-tenant auth ([[http-edge-and-intra-tenant-auth]]) and the Phase-14 web edge
  ([[web-ui-themed-edge]]). Reuses the one safety model — **no parallel one**.

## Context

Before this rung a guest was bound to a wedding only by the compose-time demo seed (`GuestRegistry.register`,
Phase 19); there was no authenticated surface for a planner to manage guests, and the only browser mutations
(login/logout) carried no anti-forgery token. Two adversarial reviews (doddy security + rigorous-architect, via
`general-purpose` agents — the named specialists are not provisioned) ran on the DESIGN (doddy
APPROVE-WITH-CHANGES, architect APPROVE) and again on the BUILT code (doddy APPROVE — no findings; architect
APPROVE-WITH-CHANGES — one stale comment, fixed). 749 tests green (was 726).

## Decisions

### 1. CSRF lives at exactly one layer — the web-owned form handlers — because that is the sole place a cookie becomes a credential

The CSRF threat is a third-party site forging a state-changing request from a logged-in planner's browser,
riding the ambient `wp_session` cookie. Two structural facts make the surface small and the seam obvious:

- **`ProductWebUi.#delegate` forwards a request to `api.handle()` verbatim — it does NOT translate the
  `wp_session` cookie into an `Authorization: Bearer` header.** Only the web-owned handlers (`#console`,
  `#login`, `#guestsPage`, and the mutations `#guestCreate`/`#guestRemove`/`#logout`) read the cookie and mint
  an internal Bearer. Therefore a cross-site `<form>` POST aimed at the **delegated JSON route**
  (`/t/:slug/guests` POST/DELETE) arrives with **no `Authorization` header** → the JSON pipeline's
  `#authenticate` returns **401**. The JSON mutation API is **not CSRF-reachable** (a browser form cannot set an
  Authorization header cross-site), so it carries **no** CSRF token — Bearer clients are not CSRF-vulnerable by
  definition. Putting CSRF inside the JSON pipeline would be the layering mistake (it would force programmatic
  Bearer clients to carry a browser-cookie concern). Proven in code by `guest_web.test.ts` (a cookie-only
  delegated POST → 401).
- The `wp_session` cookie is already `SameSite=Strict` (primary control); the synchronizer token is
  **defense-in-depth** (older browsers, same-site/subdomain vectors, an explicit testable in-app gate).

So CSRF is enforced only in the web-owned mutations: `POST /t/:slug/guests/create`, `/t/:slug/guests/remove`,
and (retrofit) `/t/:slug/logout` — each verifies the per-session `_csrf` token **before** any cookie→Bearer
translation or state change.

### 2. The CSRF token is per-session, server-side, and DISTINCT from the session token

`SessionStore` implements a narrow `CsrfGuard` (`issueCsrf`/`verifyCsrf`): at login it mints a **separate**
`ids.next('csrf')` token (never the session token), stores it `#`-private keyed by the session token, and
verifies it **fail-closed** (absent session OR empty/absent candidate ⇒ false) and **constant-time**
(`constantTimeEqual` folds the length difference into the accumulator — no early `length !==` return). The token
is **distinct** from the session token by construction: the session token lives in an HttpOnly cookie precisely
so the DOM can't read it; embedding it as a form field would write the session bearer into the page and defeat
HttpOnly. The web UI holds the SessionStore narrowed to `CsrfGuard` (issue/verify only — it cannot `login` or
`resolve` a principal), so the "only DATA path is `api.handle()`" invariant holds (CSRF is an anti-forgery
check, not a data path). A stateless double-submit cookie was rejected — it needs a JS-readable cookie,
weakening the HttpOnly + `script-src 'none'` model.

### 3. The routing split mirrors `/login` ↔ `/sessions`; the opaque ref travels in the body

The web form routes use names DISTINCT from the JSON routes so they never collide and the JSON API stays
programmatically reachable: HTML page at `/t/:slug?view=guests` (a query-view, like `?wedding=ID`); web form
posts at 4-segment `/t/:slug/guests/{create,remove}`; the JSON API at 3-segment `/t/:slug/guests`
(GET list / POST register / DELETE remove). The opaque `recipient_ref` travels in the **body**, never the URL
(no `:id` sub-path to encode, no opaque ref reflected into a path). Browsers can't issue DELETE from a form —
that is WHY the web `/guests/remove` POST exists (it translates to a JSON DELETE forward).

### 4. No-oracle discipline is preserved end-to-end

- A CSRF failure returns the SAME themed-403-or-`GENERIC_404` the disclosure model already uses (theme-iff-
  active). The slug is normalized FIRST, so an unknown tenant masks to `GENERIC_404` **before** any cookie read
  or CSRF verdict — the CSRF outcome is never a tenant-existence oracle.
- Guest CRUD is **planner-only** (`GuestAuthorizer.authorizeManage`): a couple gets `forbidden`/403 (capability
  denial, not a resource probe), anon gets 401; authorization runs before any body parse. The registry inherits
  tenant isolation from `TenantScopedRepository` (the new `delete` is context-keyed and idempotent; `list` is
  partition-scoped); a body-smuggled `tenant_id` is inert (stamped from the context).
- The register-time **wedding-existence check** (`weddings.get(context, wedding_id)` → 404 if absent) is
  referential integrity for the **trusted planner** (who owns the whole workspace), NOT an oracle — contrast
  login, which must NOT verify the couple's `wedding_id` (it is unauthenticated). A cross-tenant `wedding_id`
  reads back the masked 404 of the scoped repo. The duplicate-register 409 (`GUEST_ALREADY_REGISTERED`) is an
  honest conflict to the trusted planner (grouped with `DUPLICATE_SLUG`), not masked.
- The `?view=guests` page makes TWO `api.handle()` reads (guests FIRST — planner-only — then weddings for the
  picker); it renders only on 200/200 and otherwise takes the same `#renderNonData` mask, so a couple 403s
  before ever seeing the wedding list and there is no half-page split.

### 5. The 18th contract — `guest`

A guest binding is now an external write surface, so it earns a canonical JSON Schema like every other product
aggregate (`tenant`/`wedding`/`billing_event`/`inbound_webhook`). `GuestBinding` is aliased to the generated
`Guest` type (single source of truth, the way `Wedding`/`Tenant` are used); `register` validates the assembled
binding against it before persisting. `recipient_ref` stays opaque (no carrier pattern — vendor-agnostic, like
the messaging port). The manifest count moved 17 → 18.

## Consequences

- A planner can now manage guests from an authenticated, themed browser surface or the JSON API; the demo seed's
  guest is the first row a logged-in planner sees. Verified end-to-end against the composed surface.
- The first browser-form mutation trust surface is established with a reusable `CsrfGuard` seam; future planner
  HTML mutations (e.g. wedding create/edit forms) plug into the same pattern.
- **Deferred (recorded, not faked):** a pre-session (login) CSRF token; couples managing their own wedding's
  guests; guest edit / bulk import; unifying `product/price_book.ts` onto the shared cost basis; a richer
  wedding-facts model. A real provider sending real texts stays the human-reserved crossing (guest-comms
  tier-2). See the plan's "Out of scope".

## Alternatives considered

- **CSRF inside the JSON pipeline** — rejected (§1): the JSON API is not CSRF-reachable; this would burden
  Bearer clients with a browser concern.
- **Stateless double-submit cookie** — rejected (§2): needs a JS-readable cookie, weakening HttpOnly +
  `script-src 'none'`.
- **Reusing the session token as the CSRF token** — rejected (§2): writes the session bearer into the page DOM,
  defeating HttpOnly.
- **A separate `CsrfTokenStore`** — rejected: the token is per-session state that must be co-minted/indexed with
  the session; a separate store duplicates the map and creates a consistency hazard. The narrow `CsrfGuard`
  interface gives the cohesion without exposing `login`/`resolve` to the web UI.
- **`DELETE`/`PUT` from the browser form / the ref in the URL** — rejected: browsers can't issue them from a
  form, and the opaque ref belongs in the body, not a reflected path segment.
