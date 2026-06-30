# ADR 0037 — Guest-follow-up AUTO-reopen

- **Status:** accepted
- **Date:** 2026-06-29
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-29-phase-37-guest-followup-auto-reopen.md`)
- **Scope:** Phase 37 — when a guest texts a follow-up question that the responder cannot answer (`escalated`)
  and their most-recent escalation in their CURRENTLY-BOUND wedding is effective-**`resolved`**, the inbound
  edge now **auto-reopens that escalation** (appends a `reopened` transition attributed `resolved_by:'guest'`)
  and threads the follow-up into it — instead of opening a fresh escalation. A guest re-engaging a closed
  conversation continues ONE thread rather than spawning a pile of fresh escalations.
- **Builds on** the escalation status-transition model + operator reopen ([[escalation-status-transition-model]],
  ADR 0036 — the `reopened` transition + the effective-status fold this phase drives from an inbound message),
  guest-reply correlation ([[guest-reply-thread-correlation]], ADR 0035 — the inbound selector + the §B0
  process-once gate generalized here), and the guest escalation inbox ([[guest-escalation-inbox]], ADR 0026).
- **Closes the deferral in ADR 0036** — the SECOND half of the Phase-35 deferral (an inbound follow-up
  reopening a still-`resolved` escalation). See *Consequences* for the precise narrowing of ADR 0036's
  "Phase-37 closes this."

## Context

ADR 0036 made `reopened` an explicit OPERATOR action and added no new inbound routing — so a guest whose
follow-up arrived after their escalation was resolved still opened a SEPARATE fresh escalation (ADR 0036's
recorded interim consequence). The transition model it built is exactly what an inbound auto-reopen needs: a
`reopened` transition + an effective-status fold + directional-no-op idempotency. Phase 37 spends that.

The Phase-35 inbound selector already threads a follow-up into an effective-**OPEN** escalation. Phase 37
extends the routing to a second tier (effective-**RESOLVED**) and makes the inbound message itself the trigger
for the reopen.

## Decision

**The inbound `escalated` branch chooses its target by EFFECTIVE STATUS, in a strict preference order:**

1. **effective-OPEN exists** → thread into the most-recent open (Phase 35, **unchanged**).
2. **else effective-RESOLVED exists** → **AUTO-REOPEN** the most-recent resolved (append a `reopened`
   transition, `resolved_by:'guest'`) **THEN** thread the follow-up into it (Phase 37, **new**).
3. **else** (only effective-`dismissed`, or none) → open a **FRESH** escalation (Phase 26, **unchanged**).

Implemented by generalizing the Phase-35 selector to
`mostRecentEscalationForGuest(context, deps, wedding_id, from_ref, status)` and calling it twice —
`'open'`, then on a miss `'resolved'` — with `openTarget ?? resolvedTarget` (OPEN strictly preferred, never a
cross-tier recency compare). The reopen runs via the EXISTING `EscalationResolutionLog.transition()`; the
`MessagingHandlerDeps.resolutions` Pick widened from `'effectiveStatus'` to `'effectiveStatus' | 'transition'`
(inbound now WRITES a reopen) — the same instance compose already wires.

**`resolved_by` enum `+= 'guest'` (a MODIFY — manifest stays 21).** A guest is UNTRUSTED and NOT a Principal,
so the auto-reopen needs an honest provenance value distinct from the operator's role. `guest` is also what
keeps the uniform 202 a structural property: the inbound `escalated` branch is NOT try/caught, so a
`transition()` contract-validation throw would surface as a 500 (or, via `errorToResponse`, a 400) — an
oracle. With `guest` in the enum a valid auto-reopen row never fails validation, so neither happens.

### Why DISMISSED stays closed — the policy lives in the SELECTOR

A `dismissed` escalation is a deliberate operator "no" (spam / irrelevant / duplicate). A guest follow-up must
NOT resurrect it — a genuinely new conversation opens a fresh escalation. So the reopen-candidate set is
effective-`resolved` ONLY; `'dismissed'` is never passed to the selector. The policy is enforced **in the
selector** (it only ever returns open/resolved), **NOT** in `transition()`'s directional rule — which would
happily reopen a `dismissed` escalation (it appends `reopened` from any effective-HANDLED state). Keeping the
policy in the selector preserves the operator's dismissal as final while leaving `transition()` a clean,
status-machine-correct primitive.

### Reopen STRICTLY before thread

The `reopened` `transition()` executes strictly before `recordGuestReply()`, both inside the ONE §B0-gated,
synchronous critical section (no `await` between). So a threaded guest turn is never observed on a
still-effective-resolved escalation, and the two writes are inseparable — a re-delivery either replays both or
neither.

## Consequences

- **ADR 0036's interim coexistence consequence is closed — for the RESOLVED case.** A guest follow-up to a
  resolved escalation no longer spawns a parallel fresh escalation; it reopens and continues the original.
  This NARROWS ADR 0036's unconditional "Phase-37 closes this": the residual case where an operator manually
  reopens a DISMISSED escalation *after* a guest's follow-up already opened a fresh one stays OUT of scope — a
  dismissed escalation is never auto-reopened (a deliberate operator action would be required, and that is not
  this phase).
- **The dismissed-no-bill keystone is now CONDITIONAL via a GUEST trigger too.** ADR 0036 made it conditional
  on an OPERATOR reopen; Phase 37 adds: a guest follow-up to a *resolved* escalation auto-reopens it →
  effective-open → the Phase-28/36 reply gate (`effectiveStatus !== 'open'`) again admits billed operator
  replies. Tested end-to-end (resolve → reply blocked → guest follow-up → reply sends exactly one billed
  message). A *dismissed* escalation still blocks replies (no guest path reopens it).
- **`resolved_by:'guest'` is confined to `reopened` rows.** The widened enum lets the SCHEMA accept `guest` on
  a `resolved`/`dismissed` row, but the only writer of `by:'guest'` is the inbound auto-reopen, which
  hard-codes `status:'reopened'`; the operator route writes `by: principal.role` ∈ {planner, couple}. So a
  `guest`-attributed resolve/dismiss is structurally unproduceable. Pinned by the schema `resolved_by`
  description AND a test asserting no inbound path writes a `guest`-attributed resolved/dismissed row.
- **Uniform 202 / no new oracle.** The reopen + thread are server-side writes; the guest gets the same
  `RESP_ACCEPTED`. `transition('reopened', by:'guest')` is directional-idempotent (a second reopen from
  effective-open is a no-op) and contract-valid; `recordGuestReply` has no `body` maxLength and dedups by ref —
  neither can throw on input that passed the inbound edge. A guest cannot distinguish reopen-vs-thread-vs-fresh.
- **Process-once survives the tier change.** After the first delivery auto-reopens the escalation, a
  re-delivery of the SAME follow-up is now in a DIFFERENT selector tier (open, not resolved) — but the §B0
  gate (`escalations.getByProviderRef` ∧ `replies.guestTurnByProviderRef`) reads "already processed?" BEFORE
  routing, so it no-ops the whole branch regardless of tier. Exactly one `reopened` row + one guest turn.
  Defense-in-depth: even a double-reach is a `transition()` no-op + a ref-dedup'd `recordGuestReply`.
- **Trusted-state only.** The selector intersects `from_ref` ∧ live `binding.wedding_id` ∧ effective-status;
  the reopen's `escalation_id`/`wedding_id` are COPIED from the selected live escalation, `by:'guest'` is a
  server literal — never an inbound body field. The dual match is the Phase-35 cross-wedding mis-segmentation
  defense: a re-bound `recipient_ref` can only reopen a resolved escalation in its CURRENT wedding.
- **Render.** A guest-reopened escalation is effective-open (max-`seq` `reopened`) → it renders in the OPEN
  column; the handled badge (the only place `resolved_by` is rendered) is structurally unreachable for a guest
  row, so the `guest` attribution is never displayed.

## Alternatives considered

- **Reopen a `dismissed` escalation too** (rely on `transition()`'s permissive direction rule). Rejected: it
  silently defeats operator dismissal — a spammer could resurrect a dismissed thread by re-texting. The
  selector-level policy keeps dismissal final.
- **A separate `auto_reopen` status or a distinct log.** Rejected: `reopened` already means "back to Open";
  the only honest delta is *who* triggered it, which `resolved_by:'guest'` records on the existing append-only
  log. No new schema, no second fold.
- **A client/provider-supplied conversation id to correlate the follow-up.** Rejected (as in Phase 35): the
  port carries opaque refs and no conversation id; correlation is inferred server-side from trusted state so a
  provider can't steer routing.

## Verification

`npm run build && npm test && npm run lint` green — 989 tests (up from 983 at the start of Phase 37). doddy +
rigorous-architect lenses reviewed the design (Step 0: APPROVE-WITH-FIXES, all folded into the steps), and a
doddy lens re-reviewed the BUILT code (APPROVE — all 7 attacked properties hold, no P0/P1/P2). The named
specialist sub-agents are not provisioned here; reviews ran through `general-purpose` agents carrying the
persona lens (as Phases 34/35/36 did).
