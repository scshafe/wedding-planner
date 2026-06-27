# Phase 23 — HTML wedding create & edit forms (logistics demoable end-to-end)

## Goal
Today weddings (and the Phase-22 logistics fields) are mutable over the browser only as JSON. Give the
themed web console **browser FORMS** to create and edit a wedding — including the optional logistics fields
(`ceremony_time` / `venue_name` / `parking_info` / `dress_code`) — so the customer-facing product surface is
operable from the browser and the Phase-22 work is demoable end-to-end: a planner sets the dress code in a
form, a guest texts in, and the metered responder answers it.

This is the **wedding-mutation analogue of the Phase-21 guest forms**. It reuses the proven seam wholesale —
the same `CsrfGuard`, the same cookie→Bearer-after-CSRF translation (`bearerJson`), the same distinct
4-segment web route names that never collide with the JSON API, the same PRG (post-redirect-get) + masked
re-render discipline. **No new safety machinery, no new schema, no contract change.**

## The load-bearing design decisions (settle in Step 0, carry forward)
- **CSRF lives at exactly one layer (unchanged).** The two new form posts are cookie-authenticated mutations,
  so each verifies the per-session `_csrf` token BEFORE the cookie→Bearer translation; forged ⇒ masked 403,
  NO mutation. The delegated JSON routes (`POST /t/:slug/weddings`, `PUT /t/:slug/weddings/:id`) stay
  Bearer-only and CSRF-unreachable (a cross-site form sends no Authorization header ⇒ 401).
- **Distinct 4-seg web routes:** `POST /t/:slug/weddings/create` and `POST /t/:slug/weddings/update` (the
  wedding_id rides the BODY, mirroring guests' recipient_ref). The JSON 4-seg `/t/:slug/weddings/:id` accepts
  GET/PUT only (POST ⇒ 405), and the web router intercepts these two POST verbs BEFORE delegating, so they
  never collide. A server-minted `wedding_…` id can never equal the literal `create`/`update`.
- **Create is a CAPABILITY (planner-only, 403), not a resource oracle.** The create form renders on the
  console for every authenticated principal; a couple's submit takes the honest themed Forbidden (403) — this
  is a capability denial that probes no specific resource (per `wedding_authorizer` doc), so showing the
  affordance leaks nothing. Update masking stays a resource decision: a couple editing a non-owned id is
  masked 404 by the existing pipeline.
- **No-oracle masking carried into the forms.** A malformed slug masks to GENERIC_404 BEFORE any cookie/CSRF
  read. A failed create/update re-renders with a GENERIC notice that itself masks unknown-tenant
  (create-vs-conflict-vs-missing never leaks) — identical to the guest flow.
- **Omitted optional logistics field = unset on create, PRESERVE on update** (the Phase-22 server contract is
  unchanged; the form sends a field only when its input is non-empty). No clear-to-absent sentinel this rung.

## Steps

- [x] **Step 0 — Design review.** architect + doddy both APPROVE-WITH-FIXES; applied MF-1 (encodeURIComponent
  the body wedding_id), MF-2 (mask the empty-id 405 + issue CSRF only inside the detail-200 block), and the
  NTHs (exact 4-seg/name intercept, single-token shape, create→list redirect, no reflected raw id). Confirm the route-collision argument, the capability-vs-oracle reasoning for
  create visibility, the update-masking story, and that no new schema/contract is needed. Route an adversarial
  pass through `general-purpose` agents carrying the `rigorous-architect` + `doddy` lenses. Apply findings.

- [x] **Step 1 — Page renderers (`pages.ts`).** Add the create form inline on `renderConsole` (gains an
  `invalid` flag + a generic failure notice) and the edit form on `renderDetail` (gains `csrfToken` + an
  `invalid` flag; status `<select>` over the enum; prefilled inputs for name/date + the four logistics fields,
  each escaped via the `html` template). Reuse `csrfField`. Keep GENERIC_404/ERROR_500 untouched. Update
  `pages.test.ts` for the new signatures/fields. `npm run build && npm test && npm run lint` green.

- [x] **Step 2 — Web routing + handlers (`product_web_ui.ts`).** Add `#weddingCreate` / `#weddingUpdate`
  (CSRF-verify → cookie→Bearer `bearerJson` → delegate → PRG redirect / masked re-render). Route the two
  4-seg POSTs in `#route` (slug-mask first). Issue a CSRF token in the console DETAIL branch and pass it to
  `renderDetail`. Extract a `#weddingList(req, slug, invalid)` helper so a create-validation failure
  re-renders the console list with the notice (mirrors `#guestsPage(…, true)`). Green.

- [ ] **Step 3 — Web-flow tests (`tests/web/wedding_web.test.ts`).** Mirror `guest_web.test.ts`: planner
  create happy-path (201 → 303 → new wedding listed); couple create ⇒ themed 403 + no mutation; forged CSRF on
  create/update ⇒ masked 403 + no mutation; planner update happy-path; couple updates their OWN wedding;
  couple update of a non-owned id ⇒ masked (no mutation); logistics round-trip (set `dress_code` via the form
  → appears on the detail page); invalid body ⇒ re-render with notice (no leak); malformed-slug precedence
  over CSRF. Green.

- [ ] **Step 4 — e2e + docs.** A `product_web_ui`-level (or composed-surface) e2e: a planner creates a wedding
  with `dress_code` through the browser form, then a guest texts the inbound webhook and the metered responder
  answers the dress-code question — closing the demo loop Phase 22 opened. Write **ADR 0023**, a memory file
  (+ index it in `MEMORY.md`), and update `.claude/handoff.local.md`. Final green; commit.

## Out of scope (deferred, with reason)
- **Couple-scoped guest management** (the Phase-21 tripwire) — separate authz phase; the couple-register half
  has a tenant-global-recipient_ref collision oracle worth its own design rung.
- **Clear-to-absent logistics sentinel** — a distinct small product-completeness rung.
- **HTML create form hidden from couples by role** — would need a role signal the JSON list contract doesn't
  carry; the capability 403 is the honest boundary for now.
