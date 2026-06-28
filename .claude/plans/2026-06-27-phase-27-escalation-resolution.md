# Phase 27 — Escalation resolution / dismissal (clear the inbox)

## Goal
Phase 26 gave `escalated` a downstream surface: an unanswerable guest question lands in a per-tenant,
wedding-scoped `EscalationLog`, read by the couple (their wedding) / planner (whole tenant) via JSON
`GET /t/:slug/escalations` and a themed `?view=escalations` page. But the inbox is **append-only and
unclearable** — once a question is handled (the couple filled the fact, or it was spam) it stays in the
list forever. There is no way to mark an escalation **handled**, so the inbox only grows.

This rung makes the inbox **actionable**: the couple/planner can mark an escalation **resolved** (handled
— e.g. the fact was filled) or **dismissed** (not actionable — spam/irrelevant/duplicate). Both are
terminal "handled" states that move the escalation out of the **Open** section into a **Handled** section.
The escalation record itself stays **immutable** (ADR 0026 F6, pinned): handling is a **SEPARATE,
append-only resolution record keyed by `escalation_id`**, NOT a mutation of `guest_escalation`. The read
surface now returns both the escalations and their resolutions (scoped identically); the page joins them.

This is the natural follow-up named in the Phase-26 handoff. It introduces the inbox's **first mutation**,
so it needs a CSRF-gated browser form (reusing the Phase-21 seam wholesale) and a fresh no-oracle pass on
the resolve mutation (a couple must not be able to probe another wedding's escalation existence).

## The load-bearing design decisions (settle in Step 0, carry forward)

- **Handling is a SEPARATE append-only record keyed by `escalation_id` — the escalation stays immutable
  (ADR 0026 F6).** A new `EscalationResolutionLog` keys its OWN `TenantScopedRepository<EscalationResolution>`
  by `escalation_id` (the same self-contained-log pattern `EscalationLog`/`InboundReceiptLog` use, keyed on a
  different field). `resolve()` is **read-first-put-if-absent → FIRST-writer-wins**: resolving an
  already-handled escalation returns the existing record (the first `status` sticks). So the escalation record
  is never touched, and a handled state is immutable. Re-opening / changing a recorded status is a documented
  deferral (would need a mutation-of-a-mutation; out of scope and not yet motivated).

- **`status: 'resolved' | 'dismissed'` — two terminal handled states.** `resolved` = the couple/planner dealt
  with it (typically by filling the missing fact); `dismissed` = not actionable (spam/irrelevant/duplicate).
  Both hide the escalation from the **Open** section. The distinction is product-useful triage (and is the
  named ask — "resolution / dismissal"), at the cost of one schema enum + one validated body field. NOT a
  re-openable lifecycle: both are terminal.

- **The resolve mutation is SCOPED like guest-remove, oracle-free — NOT a capability gate.** Both roles may
  resolve, just scoped: a planner resolves ANY escalation in tenant (`manageScope` → `{kind:'all'}`); a couple
  resolves ONLY their bound wedding's escalations (`{kind:'wedding', wedding_id}`). The handler looks up the
  escalation by id (`getByEscalationId`, a tenant-scoped scan — so it can only ever see THIS tenant's records)
  and **enforces the couple's `wedding_id` match before any write**. Every miss — escalation absent, OR a
  couple's foreign-wedding escalation — returns the **byte-identical** `{ resolved: false }` (mirrors
  `handleGuestRemove`'s `{ removed: false }`), so a couple cannot probe another wedding's escalation existence
  by id. A successful resolve returns `{ resolved: true }`. (`escalation_id`s are server-minted opaque ids, so
  guessing a foreign id is already infeasible; the byte-identical miss is the belt-and-suspenders that makes it
  *provably* not an oracle.)

- **The resolution's `wedding_id`/`status`/`resolved_by` are from TRUSTED state, never the smuggled body.**
  `wedding_id` is COPIED from the looked-up escalation (not the request body — a body-smuggled `wedding_id` is
  inert, can't widen a couple's reach); `resolved_by` is `principal.role` (the minted principal, never the
  body); `resolved_at` is **clock-stamped** (the injected `Clock` at compose, never guest/ambient); `status` is
  the only body field, validated to the enum (a bad value → 400 to the already-authed principal on their own
  tenant — not an oracle, mirrors guest-register's body 400). `escalation_id` is the looked-up record's id.

- **CSRF at exactly ONE layer — the new web form handler (Phase-21 seam reused wholesale).** The inbox page
  now carries resolve/dismiss forms, so `#escalationsPage` must issue the per-session CSRF token (like
  `#guestsPage`, no longer like the read-only strategy page). A new web form route `POST
  /t/:slug/escalations/resolve` (4-seg) verifies CSRF (forged → masked 403, NO mutation) BEFORE the cookie→Bearer
  translation, then forwards to the JSON `POST /t/:slug/escalations`. The JSON mutation API is Bearer-only and
  NOT CSRF-reachable (a cross-site form can't set Authorization → 401), so it carries no token. The 4-seg web
  route never collides with the 3-seg JSON route (different segment count; mirrors `guests/{create,remove}`).

- **The read surface returns escalations AND resolutions, scoped identically; the consumer joins.** No
  annotation baked onto the immutable escalation. `handleEscalationList` returns `{ escalations, resolutions }`
  — both scoped by the SAME `manageScope` branch (planner: tenant-wide `list`; couple: `listForWedding`
  filtered by `wedding_id`, `undefined → []`). The page (and any JSON consumer) joins by `escalation_id` to
  decide Open vs Handled.

## The resolution record (20th schema: `escalation_resolution`)
`product/schemas/escalation_resolution_schema.json`, `additionalProperties:false`, all required:
- `resolution_id` — platform-minted (`ids.next('resolution')`), the public surrogate id. `minLength:1`.
- `tenant_id` — partition stamp (COMPARE-only, like every aggregate). `minLength:1`.
- `escalation_id` — the handled escalation; the **storage/idempotency KEY**. `minLength:1`.
- `wedding_id` — copied from the escalation; the couple-scope filter key. `minLength:1`.
- `status` — `enum: ['resolved','dismissed']`.
- `resolved_by` — `enum: ['planner','couple']` (`principal.role`; audit).
- `resolved_at` — ISO 8601 UTC, clock-stamped. `minLength:1`, **NO `format`/`pattern`** (F6 — match
  `received_at`; a format risks rejecting the real `clock.now()` value → a latent 500). Confirm against the real
  stamped value in Step 1.

## Steps

- [x] **Step 0 — Design review.** doddy + rigorous-architect (general-purpose lenses) both **APPROVE-WITH-FIXES**;
  **no constructible exploit found.** Confirmed PASS: (1) the resolve mutation is oracle-free for a couple —
  `getByEscalationId` scans `context.tenant_id`'s partition ALONE (cross-tenant structurally closed by the
  TenantScopedRepository brand), and absent-vs-foreign-wedding are byte-identical `{resolved:false}` provided the
  handler statement order is pinned (F1); (2) first-writer-wins leaks no distinguisher on the MUTATION surface
  (`{resolved:true}` for fresh-write and return-existing alike); a planner legitimately seeing a couple's
  resolution on the READ surface is authorized visibility, not a leak; (3) CSRF reused correctly (JSON API
  Bearer-only/token-free/not-CSRF-reachable → 401; 4-seg web route ≠ 3-seg JSON route; forged → masked 403
  no-mutation); (4) body-smuggling closed (`parseObjectBody` strips `__proto__`; wedding_id/resolved_by/
  resolved_at/tenant_id/resolution_id all from trusted state, applied last — only `escalation_id`+`status` read
  from the body; a smuggled `escalation_id` is the legit lookup key and the couple `wedding_id` match is its sole
  gate); (5) auth-before-method holds (the escalations route authenticates in the pipeline before the POST/GET/405
  dispatch — the new verb is no pre-auth oracle; unknown-tenant masks at stage 2). **Fixes folded in below:**
  **(F1, load-bearing — doddy)** PIN the resolve handler statement order so the byte-identical miss is STRUCTURAL,
  not test-hoped: parse → `requireString('escalation_id')` → **validate `status` to the enum (400, independent of
  existence)** → `getByEscalationId` → `undefined` ⇒ return the SHARED FROZEN `RESP_RESOLVE_MISS` →
  `scope.kind==='wedding' && escalation.wedding_id !== scope.wedding_id` ⇒ return the **SAME** `RESP_RESOLVE_MISS`
  → else `resolve(...)` → `{resolved:true}`. Use ONE `deepFreeze({status:200,body:{resolved:false}})` constant for
  both miss branches (so they cannot drift), and TEST `JSON.stringify` byte-equality of the absent-id and
  foreign-wedding-id responses for a couple. **(F2, load-bearing — doddy)** the couple `wedding_id` match must
  gate the WRITE: assert a sibling-wedding resolve (a) returns `{resolved:false}` AND (b) writes NO record (a
  later planner `GET /escalations` shows no resolution for that id) — the early-return precedes any `resolve()`
  call; never copy `scope.wedding_id` into the record. **(F3, load-bearing — doddy)** the 4-seg web route masks an
  unknown/malformed slug to `GENERIC_404` BEFORE any cookie read / CSRF verdict (mirror `#guestRemove`); test
  unknown-slug+forged-CSRF → 404 (not 403). **(F4, doddy)** scope BOTH read arrays by the SAME `manageScope`
  branch; test a couple bound to wedding A sees only A's resolution (the resolutions array must not become the
  cross-wedding oracle the escalations array avoids). **(F5, architect)** pin the cross-store invariant: the
  `wedding_id` written to a resolution is ALWAYS the one read from the live escalation in THIS request, never a
  prior resolution's stored value (so a future re-open rung can't desync the two stores). **(F6, architect)**
  `resolved_at` schema is `minLength:1` with **NO `format`/`pattern`** (decided now per ADR 0026 F2 — adding a
  format risks rejecting the real `clock.now()` value → a latent 500); the "confirm against the real clock value"
  task stays in Step 1. **(F7, both)** the `status` check is an INLINE `if (status!=='resolved' &&
  status!=='dismissed') throw badRequest()` → `PRODUCT.BAD_REQUEST` → masked 400 (same code a planner's malformed
  body yields — NOT a distinct code; no `requireOneOf` helper invented). **(F8, doddy)** schema keeps BOTH
  `additionalProperties:false` AND the enum/minLength floors (belt + suspenders over the body-stripping).
  **(architect)** keep `resolved_by` (cheap, real audit value, rendered on the page).

- [x] **Step 1 — The contract (20th schema) + the resolution log.** Add
  `product/schemas/escalation_resolution_schema.json` (shape above). **Confirm `resolved_at` format against the
  REAL clock-stamped value** (the same `clock.now()` the simulated adapter stamps `received_at` with; if the
  schema adds a `format`/`pattern` it MUST accept that exact value, and the log unit test must call `resolve()`
  with the real port-stamped value). Register it: add `escalation_resolution` to the `ContractKey` union + a
  `CONTRACT_DEFINITIONS` entry (product domain) in `shared/src/contracts/contract_manifest.ts`, bump its header
  comment "19"→"20" (`CONTRACT_COUNT` is derived). Update `shared/tests/contracts/schema_registry.test.ts`
  (`toBe(19)`/`toHaveLength(19)`→20 **and the title prose "exactly the 19 canonical contracts"→20**; the on-disk
  drift-guard passes automatically) and the `generate_contract_types.ts:2` header "…19 JSON Schema contracts."→
  "20"; run `npm run gen:types` (emits `EscalationResolution`); barrel-export it from `contract_types.ts` +
  `shared/src/index.ts` (mirror `GuestEscalation`). Add
  `product/src/messaging/escalation_resolution_log.ts` — `EscalationResolutionLog` over
  `TenantScopedRepository<EscalationResolution>` **keyed by `escalation_id`**, constructor `(liveness, ids,
  clock)`. Methods: `resolve(context, { escalation_id, wedding_id, status, resolved_by })` (read-first; if
  present return existing — first-writer-wins; else mint `resolution_id`, stamp `tenant_id` from context +
  `resolved_at` from clock, `assertValid`, `put`, return); `list(context)` (planner partition);
  `listForWedding(context, wedding_id)` (couple filter; `undefined → []`). Canonical doc comment covering the
  decisions. Also add `getByEscalationId(context, escalation_id): GuestEscalation | undefined` to
  `escalation_log.ts` (a tenant-scoped `list(context).find(...)`; doc-note it's a scan, fine offline, and that
  it only ever sees the context tenant's records). Unit tests
  `product/tests/messaging/escalation_resolution_log.test.ts`: resolve mints+validates+puts (real clock value);
  idempotency (same `escalation_id` → first status sticks, one record); `list` vs `listForWedding` scoping incl.
  `undefined → []`; tenant isolation; liveness (suspended throws). Extend `escalation_log.test.ts` for
  `getByEscalationId` (hit/miss/foreign-tenant). `npm run build && npm test && npm run lint` green.

- [x] **Step 2 — JSON mutation + extended read (`product_api.ts`).** Extend `EscalationHandlerDeps` to
  `{ escalations, resolutions, authorizer }`. `dispatchEscalations`: GET → `handleEscalationList`; POST →
  `handleEscalationResolve`; else → 405. `handleEscalationList` now returns `{ escalations, resolutions }` —
  both scoped by the same `manageScope` branch (all → `.list`; wedding → `.listForWedding(scope.wedding_id)`).
  `handleEscalationResolve` — **statement order PINNED (F1, load-bearing):** `manageScope(principal)`; parse
  body; `escalation_id = requireString(body,'escalation_id')`; **`status` INLINE enum check (F7) —
  `if (status!=='resolved' && status!=='dismissed') throw badRequest()`** (`PRODUCT.BAD_REQUEST` → masked 400,
  fires independent of existence, no `requireOneOf` helper); `escalation = escalations.getByEscalationId(context,
  escalation_id)`; if `undefined` → **return the SHARED FROZEN `RESP_RESOLVE_MISS`**
  (`deepFreeze({status:200, body:{resolved:false}})`, declared with the other `RESP_*` constants); if
  `scope.kind==='wedding' && escalation.wedding_id !== scope.wedding_id` → **return the SAME
  `RESP_RESOLVE_MISS`** (an unbound couple has `scope.wedding_id===undefined`, and `escalation.wedding_id` is
  always `minLength:1`, so the inequality always holds → always masked); else `resolutions.resolve(context,
  {escalation_id, wedding_id: escalation.wedding_id, status, resolved_by: principal.role})` (F5: `wedding_id` is
  ALWAYS the live escalation's, never the body / never `scope.wedding_id`) → `{status:200, body:{resolved:true}}`.
  Wire `resolutions` into the JSON `escalations` deps bag + `composeProductSurface` (ONE
  `EscalationResolutionLog`) + `ComposedSurface` (mirror `escalations`). Tests in `product/tests/http/`: planner
  resolves any tenant escalation; couple resolves only their wedding's; **(F1) `JSON.stringify` byte-equality of
  the absent-id response and the foreign-wedding-id response for a couple** (same status + body); **(F2) a
  sibling-wedding resolve returns `{resolved:false}` AND writes NO record** (a later planner `GET /escalations`
  shows no resolution for that id); a body-smuggled `wedding_id`/`resolved_by`/`__proto__` is inert (record uses
  the escalation's + the principal's); idempotency (re-resolve / re-dismiss → still one record, first status
  sticks); bad/absent `status` → 400 (present AND absent id alike); method≠GET/POST → 405; unauth → 401;
  **(F4) the list now carries `resolutions` scoped by the same `manageScope` branch (a couple bound to A sees
  ONLY A's resolution, never a sibling wedding B's)**; cross-tenant isolation. Green.

- [x] **Step 3 — Themed resolve/dismiss forms + page + e2e + docs.** `product_web_ui.ts`: `#escalationsPage`
  now issues the CSRF token (mirror `#guestsPage`: `ERROR_500` if `csrf===undefined` on a 200) and reads both
  arrays (add a tolerant `readResolutions` reader). Add the web form route `POST /t/:slug/escalations/resolve`
  (4-seg, alongside `guests/{create,remove}` + `weddings/{create,update}`): **(F3) slug-mask → `GENERIC_404`
  BEFORE any cookie read / CSRF verdict** (mirror `#guestRemove`); `#escalationResolve` verifies CSRF (forged →
  masked 403, no mutation), forwards `{escalation_id, status}` to the JSON `POST /t/:slug/escalations` via
  `bearerJson`, PRG-redirects to `?view=escalations`.
  `pages.ts` `renderEscalations(theme, slug, escalations, resolutions, csrfToken)`: join by `escalation_id`;
  **Open** section (unhandled) renders each row with a Resolve and a Dismiss button (each a CSRF-protected form
  posting `escalation_id` + `status`); **Handled** section renders the rest with a `status` badge + `resolved_by`
  (every value — including `text` — still flows through the `html` SafeHtml template; `escalation_id`/`status`
  go into hidden fields escaped). Tests `product/tests/web/pages.test.ts`: Open vs Handled split renders;
  resolve/dismiss buttons carry the CSRF field + correct `status`; an **XSS payload** in stored `text` stays
  escaped (unchanged guarantee). `product_web_ui` tests: forged-CSRF resolve → masked 403 + NO mutation;
  valid resolve → 303 redirect; unknown slug → 404 before CSRF. A compose-level **e2e** (`compose.test.ts`): a
  guest asks an unanswerable question → escalated recorded → the couple resolves it via the form → the list now
  shows it Handled (`resolved`) → a re-resolve/dismiss is idempotent (still one resolution, first status). Write
  **ADR 0027**, memory `escalation-resolution.md` (+ index in `MEMORY.md`), update `.claude/handoff.local.md`.
  Final `npm run build && npm test && npm run lint` green; commit per step.

## Out of scope (deferred, with reason)
- **Re-opening / changing a recorded status** — a handled escalation is terminal (first-writer-wins); flipping
  `resolved`↔`dismissed` or re-opening would be a mutation-of-a-mutation, not yet motivated. Its own rung.
- **Reply-from-the-inbox** — answering an escalated guest directly (a console-initiated metered send). A new
  outbound capability; larger. Now doubly motivated (resolve-by-replying).
- **Auto-resolve on fill** — automatically marking an escalation resolved when the couple fills the matching
  fact. Requires linking an escalation to the specific missing field (a `topic`/field tag the record lacks);
  deferred with the `topic` field. The manual resolve is the honest MVP.
- **Bulk resolve / filtering** — resolve-all, or a query param to show only Open. Page ergonomics; deferred.
