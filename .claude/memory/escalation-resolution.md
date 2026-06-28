---
name: escalation-resolution
description: Phase 27 — escalation resolve/dismiss; separate append-only resolution record keyed by escalation_id, first-writer-wins, oracle-free scoped mutation + CSRF
metadata:
  type: project
---

Phase 27 (ADR 0027) makes the [[guest-escalation-inbox]] **clearable**: the couple (their wedding) / planner
(whole tenant) mark a guest escalation **handled** — `resolved` (dealt with, typically the missing fact filled)
or `dismissed` (not actionable: spam/irrelevant/duplicate) — moving it from the **Open** section to **Handled**.
This is the inbox's FIRST mutation. Builds on the couple-scope pattern of [[couple-scoped-guest-management]] and
the browser-form CSRF seam of [[planner-guest-management-and-csrf]]; reuses the one safety model, no new
machinery. doddy + rigorous-architect (general-purpose lenses) both APPROVE-WITH-FIXES, no exploit found; all
fixes applied. 844 tests (was 820 at Phase 26 close).

**Why these decisions (the load-bearing set):**

- **Handling is a SEPARATE append-only record keyed by `escalation_id` — the escalation stays immutable (ADR
  0026 F6, pinned in advance).** New `EscalationResolutionLog` keys its OWN `TenantScopedRepository<EscalationResolution>`
  by `escalation_id` (the self-contained-log pattern reused, like [[guest-escalation-inbox]]'s log keyed by
  `provider_message_ref`). `resolve()` is **read-first-put-if-absent → FIRST-WRITER-WINS**: a re-resolve returns
  the EXISTING record (first `status` sticks). The `guest_escalation` is NEVER mutated — it remains the accurate
  historical fact. Re-opening / changing a recorded status is deferred (a mutation-of-a-mutation).

- **The resolve mutation is SCOPED like guest-remove, provably oracle-free — NOT a capability gate.** Both roles
  resolve, scoped: planner any-in-tenant (`manageScope`→`{kind:'all'}`), couple only their wedding
  (`{kind:'wedding',wedding_id}`). The handler does `escalations.getByEscalationId(context, id)` (a tenant-scoped
  `list().find` added to escalation_log.ts — only ever sees THIS tenant's records) then enforces the couple's
  `wedding_id` match BEFORE any write. **Every miss (absent OR couple-foreign-wedding) returns ONE shared frozen
  `RESP_RESOLVE_MISS = deepFreeze({status:200,body:{resolved:false}})`** so the two branches cannot drift —
  byte-identity is STRUCTURAL, not test-hoped (doddy F1). A successful resolve → `{resolved:true}`. So a couple
  can't probe another wedding's escalation existence by id.

- **Statement order is PINNED (doddy F1):** parse → `requireString('escalation_id')` → **`status` enum check
  (400, INDEPENDENT of existence — fires for present AND absent ids alike)** → `getByEscalationId` → absent ⇒
  MISS → couple-foreign ⇒ same MISS (early-return BEFORE any write — F2: a foreign probe records NOTHING) → else
  `resolve(...)` → true. An unbound couple has `scope.wedding_id===undefined` and the escalation's `wedding_id`
  is always `minLength:1`, so the inequality always holds → always masked.

- **Trusted-state provenance (F4/F5):** `wedding_id` is COPIED from the live escalation read in the SAME request
  (never the body, never `scope.wedding_id`); `resolved_by` is `principal.role`; `resolved_at` is clock-stamped
  inside the log (the `EscalationResolutionLog` ctor takes `(liveness, ids, clock)` — unlike `received_at` which
  the messaging PORT stamps, the resolution has no port so it owns its clock); `status` is the only body field
  (inline enum check → `PRODUCT.BAD_REQUEST` → masked 400, NOT a distinct code — F7). A smuggled
  `wedding_id`/`resolved_by`/`tenant_id`/`__proto__` is inert.

- **CSRF at ONE layer; the read returns two scoped arrays.** The inbox page now carries Resolve/Dismiss forms,
  so `#escalationsPage` issues the per-session CSRF token (like `#guestsPage`; ERROR_500 if csrf undefined on a
  200). A new 4-seg `POST /t/:slug/escalations/resolve` web route masks an unknown slug to GENERIC_404 BEFORE
  any cookie/CSRF read (F3), verifies CSRF (forged ⇒ masked 403, NO mutation), forwards to the JSON `POST
  /t/:slug/escalations` via `bearerJson`. The JSON mutation API is Bearer-only / not CSRF-reachable (no token);
  the 4-seg web route ≠ the 3-seg JSON route (no collision). `handleEscalationList` returns `{escalations,
  resolutions}` — both scoped by the SAME `manageScope` branch (a couple's resolutions never carry a sibling
  wedding's record); the page joins by `escalation_id` (Open = no resolution, Handled = has one).

**Mechanics:** 20th schema `escalation_resolution` (`resolved_at` = `minLength:1`, **no format/pattern** —
matches `received_at`, so the real `clock.now()` can't fail validation → no 500; F6). Manifest/count-test/gen
header 19→20; `gen:types` emits `EscalationResolution`. `dispatchEscalations` now GET→list / POST→resolve / else
405 (POST inherits auth-before-method — the new verb is no pre-auth oracle). ONE `EscalationResolutionLog` wired
at compose into the `escalations` deps + exposed on `ComposedSurface`. Compose e2e: guest asks unanswerable →
couple resolves via the browser form → Handled → a later dismiss is a no-op (status stays `resolved` —
first-writer-wins through the UI).
