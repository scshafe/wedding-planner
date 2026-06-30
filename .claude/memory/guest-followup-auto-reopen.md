# Guest-follow-up AUTO-reopen (Phase 37)

Phase 37 closes the SECOND half of the Phase-35 deferral ([[guest-reply-thread-correlation]]), unblocked by
the Phase-36 transition model ([[escalation-status-transition-model]]). An inbound `escalated` guest follow-up
whose most-recent escalation in the CURRENTLY-BOUND wedding is effective-**`resolved`** now AUTO-REOPENS that
escalation and threads in, instead of opening a fresh one. ADR 0037.

## The routing rule (the crux) — preference order, policy in the SELECTOR

The inbound `escalated` branch (`product_api.ts` ~line 1096) chooses its target by EFFECTIVE STATUS:
1. effective-**OPEN** exists → thread into the most-recent open (Phase 35, unchanged).
2. else effective-**RESOLVED** → **AUTO-REOPEN** it (`transition('reopened', by:'guest')`) THEN thread in (NEW).
3. else (only **dismissed**, or none) → open a FRESH escalation (Phase 26, unchanged).

Implemented by generalizing the Phase-35 selector to `mostRecentEscalationForGuest(..., status)` and calling
it twice (`'open'`, then `'resolved'`) with `openTarget ?? resolvedTarget` — OPEN strictly preferred, never a
cross-tier recency compare.

- **DISMISSED stays closed, and the policy lives in the SELECTOR — NOT in `transition()`.** `'dismissed'` is
  never passed to the selector. `transition()`'s directional rule would happily reopen a dismissed escalation
  (it appends `reopened` from ANY effective-HANDLED state) — so relying on it would be WRONG. Keeping the
  reopen-candidate policy in the selector preserves operator dismissal as final (a spammer can't resurrect a
  dismissed thread by re-texting). Tested: a dismissed follow-up opens a fresh escalation AND no `reopened` row
  is appended to the dismissed one.
- **Reopen STRICTLY before thread**, both in the ONE §B0-gated synchronous critical section (no `await`): a
  threaded guest turn is never observed on a still-effective-resolved escalation; the two writes are
  inseparable (a re-delivery replays both or neither).

## `resolved_by` enum `+= 'guest'` (MODIFY — manifest stays 21)

A guest is UNTRUSTED, not a Principal → the auto-reopen needs honest provenance distinct from an operator role.
`guest` is ALSO load-bearing for the uniform-202 invariant: the inbound `escalated` branch is NOT try/caught,
so a `transition()` contract-validation throw would become a 500 (or a 400 via `errorToResponse`) — an oracle.
With `guest` in the enum a valid auto-reopen row never fails validation.

- **`guest` is confined to `reopened` rows (arch P2-C).** The widened enum lets the SCHEMA accept `guest` on a
  resolved/dismissed row too, but the ONLY writer of `by:'guest'` is the inbound auto-reopen, which hard-codes
  `status:'reopened'`; the operator route writes `by: principal.role` ∈ {planner, couple}. So a
  `guest`-attributed resolve/dismiss is structurally unproduceable. Pinned by the schema `resolved_by`
  description + a test. A `guest`-reopened escalation is effective-open → renders in the OPEN column; the
  handled badge (the sole `resolved_by` render site) is unreachable for it, so `guest` is never displayed.

## Safety properties (carried from Phase 35/36, all re-verified by a built-code doddy review — APPROVE)

- **Uniform 202 / no new oracle.** Reopen + thread are server-side writes; the guest gets the same
  `RESP_ACCEPTED`. `transition('reopened')` is directional-idempotent (a second reopen from effective-open is a
  no-op); `recordGuestReply` has no `body` maxLength and dedups by ref — neither throws on input that passed
  the inbound edge. Reopen-vs-thread-vs-fresh is indistinguishable from the response.
- **Process-once survives the tier change.** After the first delivery auto-reopens the escalation, a
  re-delivery of the SAME follow-up is now in a DIFFERENT selector tier (open, not resolved) — but the §B0 gate
  (`getByProviderRef` ∧ `guestTurnByProviderRef`) reads "already processed?" BEFORE routing, so it no-ops the
  whole branch regardless of tier. Exactly one `reopened` row + one guest turn.
- **Trusted-state only.** Selector intersects `from_ref` ∧ live `binding.wedding_id` ∧ effective-status; the
  reopen's `escalation_id`/`wedding_id` are COPIED from the live target, `by:'guest'` is a server literal —
  never a body field. Dual match = the cross-wedding mis-segmentation defense (a re-bound `recipient_ref` can
  only reopen a resolved escalation in its CURRENT wedding).
- **Reply gate re-enabled by a GUEST trigger.** After auto-reopen the escalation is effective-open, so the
  Phase-28/36 reply gate (`effectiveStatus !== 'open'`) again admits billed operator replies — the dismissed-
  no-bill keystone is now conditional via a guest trigger too (a *dismissed* escalation still blocks replies).

## Scope narrowing of ADR 0036

Closes the RESOLVED coexistence case (a guest follow-up to a resolved escalation no longer spawns a parallel
fresh one). The residual case — an operator MANUALLY reopening a DISMISSED escalation after a guest's follow-up
already opened a fresh one — stays OUT of scope (a dismissed escalation is never auto-reopened).
