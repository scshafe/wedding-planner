# ADR 0027 — Escalation resolution / dismissal (make the inbox clearable)

- **Status:** accepted
- **Date:** 2026-06-27
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-27-phase-27-escalation-resolution.md`)
- **Scope:** Phase 27 — let the couple (their wedding) / planner (whole tenant) mark a guest escalation
  **handled** (`resolved` or `dismissed`) so the inbox can be cleared. The escalation record stays immutable;
  handling is a SEPARATE append-only resolution record keyed by `escalation_id`. Adds the inbox's first
  mutation: a JSON `POST /t/:slug/escalations` + a CSRF-gated browser Resolve/Dismiss form. The read `GET
  /t/:slug/escalations` now returns `{escalations, resolutions}` scoped identically.
- **Builds on** the escalation inbox ([[guest-escalation-inbox]], ADR 0026 — F6 pinned exactly this shape), the
  couple-scope pattern ([[couple-scoped-guest-management]]), and the browser-form CSRF seam
  ([[planner-guest-management-and-csrf]]). Reuses the one safety model — **no new safety machinery**.

## Context

Phase 26 gave `escalated` a downstream surface but the inbox was **append-only and unclearable**: once a
question was handled (the couple filled the fact, or it was spam) it stayed in the list forever, so the inbox
only grew. ADR 0026 F6 pinned the resolution shape in advance: a SEPARATE append-only record keyed by
`escalation_id`, preserving the escalation's immutability — NOT a mutation of `guest_escalation`.

Two adversarial reviews ran on the DESIGN (via `general-purpose` agents carrying the persona lens — the named
specialists are not provisioned here): **doddy APPROVE-WITH-FIXES** and **rigorous-architect
APPROVE-WITH-FIXES**, **no constructible exploit found**. All fixes folded in before building (see §6). 844
tests green (was 820 at the start of Phase 26's run; 836 → 844 across this phase's three steps).

## Decisions

### 1. Handling is a SEPARATE append-only record keyed by `escalation_id` — the escalation stays immutable (F6)

A new `EscalationResolutionLog` keys its OWN `TenantScopedRepository<EscalationResolution>` by `escalation_id`
(the same self-contained-log pattern `EscalationLog`/`InboundReceiptLog` use, keyed on a different field).
`resolve()` is **read-first-put-if-absent → FIRST-WRITER-WINS**: resolving an already-handled escalation
returns the EXISTING record (the first `status` sticks). The `guest_escalation` is never touched — it remains
the accurate historical fact that the question WAS unanswerable at the time. Re-opening / changing a recorded
status is a deferred future rung (a mutation-of-a-mutation, not yet motivated).

### 2. `status: 'resolved' | 'dismissed'` — two terminal handled states

`resolved` = dealt with (typically the missing fact was filled); `dismissed` = not actionable
(spam/irrelevant/duplicate). Both hide the escalation from the **Open** section into a **Handled** section. The
distinction is product-useful triage (the named ask), at the cost of one schema enum + one validated body
field, and adds NO new control-flow (both terminal, both hide-from-Open).

### 3. The resolve mutation is SCOPED like guest-remove, provably oracle-free — NOT a capability gate

Both roles may resolve, just scoped: a planner resolves ANY escalation in tenant (`manageScope` →
`{kind:'all'}`); a couple resolves ONLY their bound wedding's (`{kind:'wedding', wedding_id}`). The handler
looks the escalation up by id (`getByEscalationId`, a tenant-scoped scan — so it can only ever see THIS
tenant's records) and **enforces the couple's `wedding_id` match before any write**. Every miss — escalation
absent, OR a couple's foreign-wedding escalation — returns the **byte-identical** `{resolved:false}` via ONE
shared frozen `RESP_RESOLVE_MISS` constant (so the two branches cannot drift). A couple therefore cannot probe
another wedding's escalation existence by id. The statement order is PINNED so this is **structural, not
test-hoped**: parse → `requireString('escalation_id')` → **`status` enum check (400, INDEPENDENT of
existence)** → `getByEscalationId` → absent ⇒ `RESP_RESOLVE_MISS` → couple-foreign ⇒ same `RESP_RESOLVE_MISS`
(early-return BEFORE any write) → else `resolve(...)` → `{resolved:true}`.

### 4. Trusted-state provenance — `wedding_id`/`resolved_by`/`resolved_at`/`status` never the smuggled body

`wedding_id` is COPIED from the looked-up escalation in the SAME request (never the body, never
`scope.wedding_id`); `resolved_by` is `principal.role` (the minted principal); `resolved_at` is clock-stamped
inside the log (the injected `Clock`, never ambient/guest); `tenant_id`/`resolution_id` are
context/server-minted. `status` is the ONLY body field, an inline enum check → `PRODUCT.BAD_REQUEST` → masked
400 (the same code a planner's malformed body yields — not a distinct code). `parseObjectBody` strips
`__proto__`/`constructor`/`prototype`, and the schema is `additionalProperties:false` — belt + suspenders.

### 5. CSRF at exactly ONE layer; the read returns two scoped arrays

The inbox page now carries Resolve/Dismiss forms, so `#escalationsPage` issues the per-session CSRF token (like
`#guestsPage`, no longer like the read-only strategy page). A new 4-seg web route `POST
/t/:slug/escalations/resolve` masks an unknown slug to `GENERIC_404` BEFORE any cookie read / CSRF verdict
(no tenant-existence oracle), verifies CSRF (forged ⇒ masked 403, NO mutation), then forwards to the JSON
route. The JSON mutation API is Bearer-only and NOT CSRF-reachable (a cross-site form can't set Authorization →
401), so it carries no token; the 4-seg web route never collides with the 3-seg JSON route. The read returns
`{escalations, resolutions}` — both scoped by the SAME `manageScope` branch (a couple's `resolutions` array
never carries a sibling wedding's record); the consumer joins by `escalation_id` to decide Open vs Handled.

## Mechanics

- **20th schema** `escalation_resolution` (`resolution_id`/`tenant_id`/`escalation_id`/`wedding_id`/`status`
  enum/`resolved_by` enum/`resolved_at`). `resolved_at` is `minLength:1` with **no `format`/`pattern`** (matches
  `received_at` — a format risks rejecting the real `clock.now()` value → a latent 500). Manifest + count test +
  gen-script header 19→20; `gen:types` emits `EscalationResolution`; barrel-exported from shared + product.
- **`EscalationResolutionLog`** — a thin face over `TenantScopedRepository<EscalationResolution>` keyed by
  `escalation_id`, ctor `(liveness, ids, clock)`. `resolve` (idempotent/first-writer-wins) / `list` (planner) /
  `listForWedding` (couple). **`EscalationLog.getByEscalationId`** (a tenant-scoped `list().find`) added for the
  couple-scope lookup.
- **`product_api.ts`** — `dispatchEscalations` now GET→list / POST→`handleEscalationResolve` / else 405;
  `handleEscalationList` returns `{escalations, resolutions}`; the shared frozen `RESP_RESOLVE_MISS`;
  `EscalationHandlerDeps` gains `resolutions`.
- **`product_web_ui.ts` + `pages.ts`** — `#escalationsPage` issues CSRF + reads both arrays
  (`readResolutions`); the 4-seg `escalations/resolve` form route + `#escalationResolve`; `renderEscalations`
  splits Open (with Resolve/Dismiss CSRF forms) vs Handled (status badge + `resolved_by`).
- **`compose.ts`** — ONE `EscalationResolutionLog` wired into the `escalations` deps (read + resolve); exposed
  on `ComposedSurface`. A compose e2e proves the loop: guest asks unanswerable → couple resolves via the
  browser form → it moves to Handled → a later dismiss is a no-op (status stays `resolved` — first-writer-wins).

## §6 Review fixes folded in

- **F1 (load-bearing, doddy):** PIN the handler statement order; ONE shared frozen `RESP_RESOLVE_MISS` for both
  miss branches (byte-identity is STRUCTURAL); test `JSON.stringify` byte-equality of the absent-id and
  foreign-wedding-id responses for a couple. Applied + tested.
- **F2 (load-bearing, doddy):** the couple `wedding_id` match gates the WRITE — a sibling-wedding probe returns
  `{resolved:false}` AND records nothing (tested via a later planner read showing no resolution).
- **F3 (load-bearing, doddy):** the 4-seg web route masks an unknown slug BEFORE the CSRF verdict
  (unknown-slug → 404, never 403).
- **F4 (doddy):** both read arrays scoped by the same `manageScope` branch; tested a couple bound to A never
  sees B's resolution.
- **F5 (architect):** the `wedding_id` written is ALWAYS the live escalation's, read in the same request —
  never a prior resolution's stored value.
- **F6 (architect):** `resolved_at` is `minLength:1`, no format (decided up front per ADR 0026 F2).
- **F7 (both):** inline `status` enum check → `PRODUCT.BAD_REQUEST` → masked 400 (no `requireOneOf` helper, not
  a distinct code).
- **F8 (doddy):** schema keeps BOTH `additionalProperties:false` AND the enum/minLength floors.

## Consequences

- The escalation inbox is now actionable: a handled question moves out of the Open list, so the inbox reflects
  outstanding work rather than growing forever. The escalation record stays immutable (the resolution is a
  separate fact); a re-delivery that now answers still records no new escalation, and a handled one stays
  handled.
- **Deferred:** re-opening / changing a recorded status (first-writer-wins is terminal); reply-from-the-inbox (a
  console-initiated metered send — now doubly motivated by resolve-by-replying); auto-resolve on fill (needs an
  escalation→field link the record lacks); bulk resolve / Open-only filtering (page ergonomics). See the plan.

Memory: [[escalation-resolution]].
