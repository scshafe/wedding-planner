# Phase 37 — guest-follow-up AUTO-reopen (the SECOND half of the Phase-35 deferral)

## Goal

An inbound `escalated` follow-up from a guest whose most-recent escalation in their CURRENTLY-BOUND wedding is
effective-**`resolved`** should **REOPEN that escalation** (append a `reopened` transition) and thread the
follow-up into it — instead of opening a FRESH escalation. This is the SECOND half of the Phase-35 deferral
([[guest-reply-thread-correlation]] / [[escalation-status-transition-model]]), unblocked by the Phase-36
transition model, and it CLOSES the interim coexistence note in ADR 0036 (a guest follow-up to a resolved
escalation no longer spawns a parallel fresh escalation alongside the old one).

Phase 35 already threads a follow-up into an **OPEN** escalation. Phase 36 added the operator **reopen**
transition. Phase 37 makes a guest follow-up itself trigger that reopen when the prior conversation was
resolved — so a resolved conversation a guest re-engages becomes one continuous thread, not a pile of
fresh escalations.

## The routing rule (the crux)

In the inbound `escalated` branch, after the §B0 process-once gate, choose the target by EFFECTIVE STATUS,
PREFERRING an open conversation, then a resolved one, then opening fresh:

1. **effective-OPEN exists** → thread into the most-recent open (Phase 35, **unchanged**).
2. **else effective-RESOLVED exists** → **AUTO-REOPEN** the most-recent resolved (append a `reopened`
   transition, attributed `resolved_by:'guest'`) THEN thread the follow-up into it (Phase 37, NEW).
3. **else** (only effective-`dismissed`, or none) → open a FRESH escalation (Phase 26/35, **unchanged**).

### Why dismissed stays closed (the design decision)

A `dismissed` escalation is a deliberate operator "no" (spam / irrelevant / duplicate). A guest follow-up
must NOT resurrect it — a new conversation opens a fresh escalation. So the candidate set for reopen is
effective-`resolved` ONLY; `dismissed` is excluded by the selector (NOT by the `transition()` directional
rule, which would happily reopen a dismissed one — the POLICY lives in the selector). This matches the
handoff guidance and keeps operator dismissal meaningful.

### Why `resolved_by:'guest'` (the schema change)

A guest is UNTRUSTED and NOT a Principal — the auto-reopen is not an operator action. The `escalation_resolution`
`resolved_by` enum is `planner|couple`; an auto-reopen needs an honest provenance value, so we add **`guest`**
(MODIFY — manifest stays **21**). This is also REQUIRED for the uniform-202 invariant: `transition()`
contract-validates the row, and the inbound escalated branch is NOT try/caught — a validation throw would
become a 500, breaking the uniform 202. With `guest` in the enum, a valid auto-reopen row never fails
validation (no 500 oracle). `resolved_by:'guest'` only ever appears on a `reopened` row, which renders in the
OPEN column (never as a handled badge — pages.ts:459/468 reads `resolved_by` only for resolved/dismissed
badges), so it is never displayed and the operator resolve/dismiss handler (`by: principal.role`) is untouched.

## Safety properties to preserve (carry from Phase 35/36)

- **Uniform 202 / no new oracle.** The reopen + thread are server-side writes; the guest gets the SAME
  `RESP_ACCEPTED`. `transition('reopened', by:'guest')` and `recordGuestReply` cannot throw on input that
  passed the inbound edge (enum has `guest`; `escalation_reply.body` has no maxLength), so the 202 stays uniform.
- **Process-once (§B0).** The existing two-read gate (`escalations.getByProviderRef` ∧
  `replies.guestTurnByProviderRef`) already wraps this branch, so a provider RE-DELIVERY never double-reopens
  or double-threads. Defense-in-depth: `transition()` is a directional no-op (a second `reopened` from
  effective-open is a no-op), so even a double-reach is safe.
- **Trusted-state only.** The selector intersects `from_ref` ∧ live `binding.wedding_id` ∧ effective-status —
  all trusted (live binding + recorded escalation), never the inbound body. The reopen's `wedding_id`/
  `escalation_id` are COPIED from the selected live escalation, never a body field.
- **Cross-wedding mis-segmentation defense (Phase 35).** Filtering candidates by the CURRENT
  `binding.wedding_id` excludes a re-bound recipient_ref's stale escalations — so a re-bound guest can only
  reopen a resolved escalation in their current wedding.
- **Reply gate re-enabled.** After auto-reopen the escalation is effective-`open`, so the Phase-28/36 reply
  gate (`effectiveStatus !== 'open'`) again admits billed operator replies — the conversation is live.

## Steps

- [x] **Step 0 — Design review (doddy + architect lenses).** Both `general-purpose` agents (persona lens)
  returned **APPROVE-WITH-FIXES** — no design change; all findings are hardening + tests + doc-precision.
  **Folded into the steps below:**
  - (doddy P1 / arch ordering) reopen `transition()` STRICTLY BEFORE `recordGuestReply()` in the SAME
    §B0-gated block — load-bearing, with a one-line comment; a re-delivery test asserts EXACTLY ONE
    `reopened` row AND EXACTLY ONE guest turn (inseparability).
  - (doddy P2 / rationale) a `transition()` validation throw maps to **400** via `errorToResponse`
    (`CONTRACT.VALIDATION_FAILED`), **not 500** — an even cleaner oracle; the `resolved_by:'guest'` enum add is
    what keeps it unreachable. Correct the wording in the ADR (the plan's "500" framing above is the mechanism
    error doddy flagged).
  - (arch P2-C, the load-bearing one) widening the enum lets the schema ACCEPT `resolved_by:'guest'` on a
    `resolved`/`dismissed` row too; `guest` must appear ONLY on a `reopened` row. Pin it: (1) schema
    `resolved_by` description says so; (2) a test asserts no inbound path ever writes a `resolved`/`dismissed`
    row with `resolved_by:'guest'`.
  - (doddy P2 / arch) the dismissed-stays-closed test asserts NO `reopened` row is appended to the dismissed
    escalation specifically (pins the SELECTOR policy, independent of `transition()`'s permissive direction rule).
  - (arch P2-A) ADR 0037 NARROWS ADR 0036's unconditional "Phase-37 closes this": it closes the
    resolved-coexistence case; the residual operator-manual-reopen-of-a-DISMISSED-escalation-after-a-fresh-one
    stays out of scope (deliberate operator action).
  - (arch P2-B) the generalized selector's header is PER-TIER: for the resolved tier the recency pick IS the
    conversation being reopened (not "immaterial" as the open-tier prose said).
  - (arch) add the adversarial re-delivery test: a re-delivery arriving AFTER the auto-reopen made the
    escalation effective-open (a DIFFERENT selector tier than first delivery) → §B0 still no-ops it (no second
    `reopened`, no second thread). Don't re-describe the §B0 gate prose — only append the routing-tier note.

- [x] **Step 1 — Schema MODIFY + types.** `escalation_resolution_schema.json`: `resolved_by` enum
  `+= "guest"`; update its `description` (a `reopened` transition MAY be attributed to `guest` for an inbound
  auto-reopen — the guest follow-up that triggered it; still never read for a decision). `npm run gen:types`.
  Manifest stays **21** (MODIFY, not a new schema). Green.

- [x] **Step 2 — Inbound handler (the routing).** `product_api.ts`:
  - Widen `MessagingHandlerDeps.resolutions` Pick to `'effectiveStatus' | 'transition'` (inbound now WRITES a
    reopen) + refresh the doc comment. `compose.ts` wiring follows the Pick (same instance).
  - Generalize the Phase-35 selector to `mostRecentEscalationForGuestWithStatus(context, deps, wedding_id,
    from_ref, status: EffectiveEscalationStatus)` (filter on `effectiveStatus === status`; max-by `received_at`,
    tie by `escalation_id` — determinism only), and call it twice.
  - The escalated branch: `openTarget = …'open'`; `target = openTarget ?? …'resolved'`. If
    `target !== undefined`: when `openTarget === undefined` (we fell through to a resolved target) FIRST
    `deps.resolutions.transition(context, { escalation_id, wedding_id, status:'reopened', by:'guest' })`
    (escalation_id/wedding_id COPIED from `target`), THEN `recordGuestReply` into `target` (Phase 35 path,
    now shared). Else → `escalations.record` fresh (unchanged). Update the §B0 / selector header comments.
  - Green (`npm run build && npm test && npm run lint`).

- [x] **Step 3 — Tests.** Handler tests in the inbound/messaging suite:
  - guest follow-up to a guest whose most-recent escalation is RESOLVED → the escalation is effective-`open`
    again (a `reopened` row, `resolved_by:'guest'`) AND the follow-up is a `sender:'guest'` thread turn; still
    202; NO send / NO charge (meter total unchanged).
  - guest follow-up when the most-recent is DISMISSED → a FRESH escalation opens (no reopen of the dismissed).
  - re-delivery of the same auto-reopen follow-up (same provider_message_ref) → process-once: exactly one
    `reopened` row + one guest turn (no double-reopen, no second thread row).
  - OPEN-preferred: a guest with both an open and an older resolved escalation → threads into the OPEN one, no
    reopen (Phase 35 unchanged).
  - reply-gate re-enabled: after an auto-reopen, an operator console reply now SENDS exactly one billed message
    (the Phase-28/36 keystone, now reachable via the guest-driven reopen).
  - page test: a guest-reopened escalation renders in the OPEN column (effective-open), not Handled.
  - Migrate any existing inbound test that assumed a resolved-escalation follow-up opens a fresh escalation.
  - Green.

- [ ] **Step 4 — Docs.** ADR 0037 (the routing rule, the dismissed-stays-closed decision, `resolved_by:'guest'`,
  the coexistence-closure of ADR 0036's interim note + the residual operator-manual-reopen-of-dismissed case
  left out of scope); memory [[guest-followup-auto-reopen]] + MEMORY.md index; tick these boxes; refresh
  `.claude/handoff.local.md` (Phase 37 complete; next levers). Commit per step.

## Verification

`npm run build && npm test && npm run lint` green before every box tick and commit (run build/lint standalone,
check exit codes — never pipe through tail/grep when `&&`-gating). Per-step commits on
`build/phase-37-guest-followup-auto-reopen`.
