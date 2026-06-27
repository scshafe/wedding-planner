---
name: planner-guest-management-and-csrf
description: "Phase 21: the planner-facing guest-management CRUD surface (GET/POST/DELETE /t/:slug/guests + a themed ?view=guests page) and the FIRST browser-form CSRF — a per-session synchronizer token, distinct from the session token, verified constant-time at the WEB layer only (the sole place a cookie becomes a credential); the JSON API is Bearer-only and structurally not CSRF-reachable. The 18th schema (guest). Channel operability, no new safety machinery."
metadata:
  node_type: memory
  type: project
---

**Phase 21 (the product-surface OPERABILITY rung of [[guest-messaging-channel-is-a-roadmap-goal]]).** Both
human-set channel constraints were already DONE (no-lock-in: Phase 18; pricing+scoring: Phases 18+20), so this
rung adds NO new channel safety machinery — it makes the channel **operable by a real planner**: an
authenticated surface to register/list/remove guests, plus the **first planner *mutation* trust surface over a
browser** (HTML forms + CSRF — the guard Phase 19 deliberately deferred, [[guest-messaging-inbound-edge]]). ADR
0021. 749 tests (from 726). doddy+architect APPROVE design AND built code (built: doddy no findings).

**The load-bearing decisions / invariants (carry forward):**

- **CSRF lives at EXACTLY ONE layer — the web-owned form handlers — because that is the SOLE place a cookie
  becomes a credential.** `ProductWebUi.#delegate` forwards to `api.handle()` **verbatim** (no cookie→Bearer
  translation); only web-owned handlers read `wp_session` and mint an internal Bearer. So a cross-site `<form>`
  POST to the **delegated JSON route** (`/t/:slug/guests`) arrives with **no `Authorization` header → 401**: the
  JSON mutation API is **NOT CSRF-reachable** (a browser form can't set an Authorization header cross-site) and
  carries NO token. The missing-Bearer 401 — NOT SameSite — is what stops it (SameSite=Strict is the primary
  control; the token is defense-in-depth). Putting CSRF in the JSON pipeline would be the layering mistake.
  Proven by `guest_web.test.ts` (cookie-only delegated POST → 401).

- **The CSRF token is per-session, server-side, and DISTINCT from the session token.** `SessionStore` implements
  a narrow `CsrfGuard` (`issueCsrf`/`verifyCsrf`): login mints a SEPARATE `ids.next('csrf')` token (never the
  session token — embedding the session bearer in a form field would defeat HttpOnly), stored `#`-private keyed
  by the session token. `verifyCsrf` is **fail-closed** (absent session OR empty/absent candidate ⇒ false) and
  **constant-time** (`constantTimeEqual` folds the length diff into the accumulator — NO early `length !==`
  return). The web UI holds the store narrowed to `CsrfGuard` (issue/verify only, not login/resolve), so the
  "only DATA path is `api.handle()`" invariant holds (csrf reads no tenant data). The `sessionToken` passed to
  `verifyCsrf` MUST be the same token then forwarded as the Bearer (no verify-A-execute-as-B).

- **The browser mutations that verify CSRF:** `POST /t/:slug/guests/create`, `/t/:slug/guests/remove`, and
  (retrofit) `/t/:slug/logout` — each verifies BEFORE any state change, and a forged token returns the masked
  403 with NO mutation (a forged logout no longer clears the cookie — closed a live logout-CSRF). **Login is the
  documented exemption** (no session yet to bind a token to; SameSite covers it).

- **The routing split mirrors `/login`↔`/sessions`; the opaque ref is in the BODY.** HTML page at
  `/t/:slug?view=guests` (query-view like `?wedding=ID`); web form posts at 4-seg `/t/:slug/guests/{create,
  remove}`; JSON API at 3-seg `/t/:slug/guests` (GET/POST/DELETE). DISTINCT names ⇒ no collision + JSON stays
  programmatically reachable. `recipient_ref` travels in the body, never the URL (no `:id`, no reflected opaque
  ref). The web `/guests/remove` POST exists BECAUSE a browser form can't issue DELETE (it forwards to a JSON
  DELETE).

- **No-oracle preserved.** CSRF failure → themed-403-or-`GENERIC_404` (theme-iff-active); the slug is normalized
  FIRST so an unknown tenant masks BEFORE the CSRF verdict (CSRF outcome is never a tenant-existence oracle).
  Guest CRUD is **planner-only** (`GuestAuthorizer.authorizeManage` — couple→403, anon→401, authorize before
  body-parse). The register-time **wedding-existence check is NOT an oracle for a planner** (they own the
  workspace) but WOULD be for login (which must not verify the couple's wedding_id). Duplicate-register →
  honest 409 (`GUEST_ALREADY_REGISTERED`, grouped with `DUPLICATE_SLUG`, not masked). Remove is idempotent
  (`{removed}`). `?view=guests` fetches guests FIRST (planner-only) then weddings, single-status masked.

- **The 18th schema `guest`** (a guest binding is now an external write surface). `GuestBinding = Guest` (the
  generated type — single source, like `Wedding`/`Tenant`); `register` validates against it. `recipient_ref`
  stays opaque (no carrier pattern). `TenantScopedRepository.delete` (context-keyed, idempotent, no oracle) and
  `GuestRegistry.list`/`remove` inherit isolation. Manifest count 17 → 18.

**Tripwire / deferred:** a pre-session (login) CSRF token; **couples managing their own wedding's guests**
(reopens the couple-vs-planner resource-scoping in `GuestAuthorizer`, today planner-only capability); guest
edit / bulk import; unify `product/price_book.ts` onto the shared cost basis; a richer wedding-facts model. A
real provider sending real texts stays the human-reserved crossing (guest-comms tier-2). A future planner HTML
mutation (wedding create/edit forms) plugs into the SAME `CsrfGuard` seam.
