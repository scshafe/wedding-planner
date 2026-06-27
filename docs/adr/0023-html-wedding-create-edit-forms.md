# ADR 0023 — HTML wedding create & edit forms (the logistics demo loop closes in the browser)

- **Status:** accepted
- **Date:** 2026-06-27
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-27-phase-23-html-wedding-forms.md`)
- **Scope:** Phase 23 — give the themed white-label web console **browser FORMS** to create a wedding (planner) and
  edit one (planner any / couple own), including the Phase-22 optional logistics fields. This is the
  **wedding-mutation analogue of the Phase-21 guest forms** ([[planner-guest-management-and-csrf]]) and reuses that
  seam wholesale: same `CsrfGuard`, same cookie→Bearer-after-CSRF translation, same distinct 4-segment web routes, same
  PRG + masked-re-render discipline. **No new safety machinery, no new schema, no contract change.**
- **Builds on** the Phase-14 web edge ([[web-ui-themed-edge]]), the Phase-21 CSRF seam, and the Phase-22 logistics
  fact model ([[richer-guest-visible-facts]]). Reuses the one safety model — **no parallel one**.

## Context

Before this rung, weddings (and their Phase-22 logistics) were mutable over the browser only as raw JSON — the HTML
console was read-oriented (list / detail / strategy / guest-management). The product direction wants a demoable
customer-facing surface; the satisfying end-to-end loop Phase 22 opened (a planner sets a logistic, a guest texts and
the metered responder answers it) could not be driven through the UI. This rung closes that loop in the browser.

Two adversarial reviews (doddy security + rigorous-architect, via `general-purpose` agents carrying the persona lens —
the named specialists are not provisioned here) ran on the DESIGN: both **APPROVE-WITH-FIXES**, all fixes applied
before building. 780 tests green (was 762).

## Decisions

### 1. Two distinct 4-segment web routes; the body wedding_id is URL-encoded into the PUT path

`POST /t/:slug/weddings/create` forwards (after CSRF) to the JSON `POST /t/:slug/weddings`; `POST
/t/:slug/weddings/update` forwards to the JSON `PUT /t/:slug/weddings/:id`. The wedding_id rides the FORM body
(mirroring guests' recipient_ref). The web router intercepts these two POST verbs **before** delegating; the JSON 4-seg
`/t/:slug/weddings/:id` route accepts GET/PUT only (a POST ⇒ 405), and a server-minted `wedding_…` id can never equal
the literal `create`/`update`, so the routes provably never collide. **This invariant is load-bearing** — a real id is
never `create`/`update`, so a `GET/PUT/DELETE /t/:slug/weddings/create` falling through to the JSON handler treats
`create` as a (non-existent) id and masks to 404, never a route the literal could re-target.

**MUST-FIX (both reviewers): `encodeURIComponent` the body wedding_id into the PUT URL** (reusing the existing detail-GET
pattern). The id is attacker-controlled at that point; without encoding, a value like `../sessions` or one containing
`/` re-segments the path and could smuggle the request onto a sibling JSON route. Encoded, every breakout attempt (`/`,
`?`, `#`, `..`) collapses to one opaque segment, so the route stays `/t/:slug/weddings/:id` and the value resolves to a
non-existent/non-owned id → masked 404. Identity stays **URL+context-stamped**: the JSON `handleUpdate` sets wedding_id
from the route and tenant_id from the context LAST, so a body-smuggled identity key is inert (unchanged from Phase 13).

### 2. The empty / collapsing wedding_id masks byte-identically to a missing id (no raw 405 oracle)

`encodeURIComponent('') === ''`, so an empty body wedding_id yields a 3-segment `PUT /t/:slug/weddings` → the JSON
collection route → 405. **MUST-FIX (doddy):** that 405 must not surface as a distinguishable outcome. The update
handler re-renders the detail page on ANY failure, and the detail re-fetch of an empty/non-owned id itself masks to
`GENERIC_404` (a 3-seg GET returns the list, whose body has no single `wedding` ⇒ masked; a non-owned id GET returns
404 ⇒ masked). So an empty id, a non-owned id, and a missing id are **byte-identical GENERIC_404** to the user — the
no-oracle masking carried into the new form, proved by a test.

### 3. Create is a CAPABILITY affordance (couple → themed 403), not a resource oracle

The create form renders on the console for **every** authenticated principal; a couple's submit returns the JSON
403 (create is planner-only) → themed Forbidden. `authorizeCreate` is a pure capability decision that probes **no**
specific resource (per `wedding_authorizer`), so showing the affordance leaks nothing and the 403 is constant
regardless of any tenant/wedding state. Hiding it from couples would need a role signal the weddings-list contract does
not carry (a couple CAN list their own wedding, so the list 200 is not a planner-only gate); the honest capability 403
is the boundary for this rung. The edit form lives on the detail page and is universal — both planner (any) and couple
(own only; a non-owned id is masked to 404 by the pipeline before the form is ever rendered) may submit.

### 4. CSRF is unchanged and lives at exactly one layer

Both new mutations verify the per-session `_csrf` synchronizer token (fail-closed, constant-time) BEFORE the
cookie→Bearer translation and before any mutation; a forged token ⇒ masked 403 with NO state change (proved for both
create and update). The detail page now issues a CSRF token for the edit form — **issued ONLY inside the `api.handle()`
200 block** (mirroring the list-branch invariant: a resolved 200 session must have a token in the same store, so
`csrf === undefined` is an invariant break ⇒ `ERROR_500`; `theme === undefined` ⇒ `GENERIC_404`). Because the token is
minted only on the own-wedding 200 path, it adds no oracle to a couple probing another couple's id (that path masks to
404 before any render). The JSON mutation API stays Bearer-only and not CSRF-reachable (a cross-site form sets no
Authorization header ⇒ 401), proved for both POST and PUT.

### 5. Omitted optional field = unset on create / PRESERVE on update (no clear-to-absent from the browser yet)

The form sends an optional logistics field only when its input is non-empty, so an empty input is OMITTED from the
request body — create leaves it unset, update preserves the stored value (the unchanged Phase-22 `patchOptional`
contract). A consequence: **blanking a logistics field to remove it is not expressible from the browser** — a known,
bounded limitation (a future clear-to-absent sentinel rung), surfaced in the form copy so it is not mistaken for a bug.

## Consequences

- The customer-facing surface is now **operable from the browser for the core wedding aggregate** — a planner creates
  and a planner/couple edits weddings + logistics without touching JSON. The Phase-22 demo loop closes end-to-end: an
  e2e test logs a planner into the HTML front door, sets `dress_code` via the edit form, and a guest texting "dress
  code" goes from **escalated (no send, meter 0)** to **answered (one metered reply, meter 1)** — the browser-set fact
  reaching the guest reply through the real wired surface.
- No new schema (the 18-schema manifest is unchanged); no JSON contract change; the JSON layer + the keystone HTTP
  behavior are byte-for-byte preserved (the two new routes are web-layer-only intercepts).
- 780 tests green (15 new web-flow tests + 5 new page-render assertions + 1 compose e2e). doddy + architect APPROVE
  the design (with the must-fixes applied in the build).

## Alternatives considered

- **A dedicated `/t/:slug/weddings/new` create page** — rejected: create has no resource to mask, so a separate page
  (an extra route + a second CSRF-issuing read) buys no isolation; inline-on-console matches the guests add-form
  altitude.
- **Hiding create from couples by reading their role** — rejected: needs a role signal the list contract does not
  expose; the capability 403 is the honest, oracle-free boundary.
- **Couple-scoped guest management** (the Phase-21 tripwire) — deferred to its own authz rung: the couple-register half
  has a tenant-global-recipient_ref collision oracle that deserves dedicated design.
