---
name: html-wedding-create-edit-forms
description: Phase 23 — browser create/edit wedding forms reusing the Phase-21 CSRF seam; the body wedding_id must be encodeURIComponent'd into the PUT URL, empty/collapsing/non-owned ids all mask byte-identically, create is a capability (couple→403)
metadata:
  type: project
---

Phase 23 gave the themed web console **browser FORMS** to create a wedding (planner) and edit one
(planner any / couple own), incl. the Phase-22 logistics fields — the wedding-mutation analogue of the
Phase-21 guest forms ([[planner-guest-management-and-csrf]]), reusing that seam wholesale (same `CsrfGuard`,
cookie→Bearer-after-CSRF, distinct 4-seg web routes, PRG + masked re-render). No new schema/contract; the
JSON layer is byte-for-byte preserved. ADR 0023. 780 tests. doddy+architect APPROVE design (must-fixes
applied in the build).

**The load-bearing facts (carry forward):**

- **The body `wedding_id` MUST be `encodeURIComponent`'d into the PUT URL** (`#weddingUpdate` builds
  `PUT /t/:slug/weddings/${encodeURIComponent(weddingId)}`). The id is attacker-controlled at that point;
  unencoded, `../sessions` or a `/`-bearing value re-segments the path onto a sibling route. Encoded, every
  breakout collapses to ONE opaque segment → resolves to a non-existent id → masked 404. Identity stays
  URL+context-stamped (the JSON `handleUpdate` sets wedding_id from the route + tenant_id from the context
  LAST, so a body-smuggled identity key is inert — Phase 13 invariant, unchanged).

- **Empty/collapsing/non-owned ids all mask to one byte-identical `GENERIC_404`** — `encodeURIComponent('')===''`
  yields a 3-seg `PUT /t/:slug/weddings` → 405, but the failure ALWAYS re-renders the detail page and the
  detail re-fetch of an empty/non-owned id itself masks (a 3-seg GET returns the list whose body has no single
  `wedding`; a non-owned GET returns 404). So no raw 405/400 oracle reaches the user. Proved by tests.

- **Create is a CAPABILITY affordance, not a resource oracle.** The create form renders on the console for
  EVERY authenticated principal; a couple's submit → JSON 403 → themed Forbidden. `authorizeCreate` probes no
  specific resource, so showing it leaks nothing, and the 403 is constant. Hiding it from couples would need a
  role signal the weddings-list contract doesn't carry (couples CAN list their own wedding, so the list 200 is
  not a planner-only gate). The honest capability 403 is the boundary.

- **The detail page now issues a CSRF token for the edit form — ONLY inside the `api.handle()` 200 block**,
  mirroring the list-branch invariant (`csrf===undefined` ⇒ ERROR_500; `theme===undefined` ⇒ GENERIC_404). The
  token is minted only on the own-wedding 200 path, so it adds NO oracle to a couple probing another couple's
  id (that path masks to 404 before any render). `#console` was refactored into `#weddingList` + `#detail`
  helpers (both take an `invalid` flag for the failure re-render, mirroring `#guestsPage`).

- **The two new web routes provably never collide with the JSON 4-seg `/t/:slug/weddings/:id`** — a
  server-minted `wedding_…` id can never equal the literal `create`/`update`, and the POST-only web intercept
  runs before `#delegate`. State this invariant when touching the routing table.

- **Omitted optional logistics field = unset on create / PRESERVE on update** (the form sends a field only when
  non-empty). Consequence: **blanking a logistics field to remove it is NOT expressible from the browser yet** —
  a bounded limitation (the deferred clear-to-absent sentinel rung), noted in the form copy so it's not a bug.

- The demo loop now closes end-to-end IN THE BROWSER: the compose e2e logs a planner into the HTML front door,
  sets `dress_code` via the edit form, and a guest texting "dress code" goes from escalated (meter 0) to
  answered (one metered reply, meter 1) — the browser-set fact reaching the guest reply through the wired
  surface ([[richer-guest-visible-facts]], [[guest-messaging-channel-is-a-roadmap-goal]]).
