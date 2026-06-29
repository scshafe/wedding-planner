# ADR 0036 — Escalation status-transition model + operator reopen

- **Status:** accepted
- **Date:** 2026-06-29
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-29-phase-36-escalation-reopen.md`)
- **Scope:** Phase 36 — let a HANDLED guest escalation (`resolved`/`dismissed`) return to the **Open** inbox
  via an explicit operator **reopen** action, so an operator who closed a question prematurely (or wants to
  send another reply turn) can re-open it instead of being stuck. This required replacing the single-record,
  first-writer-wins, **terminal** resolution log ([[escalation-resolution]], ADR 0027) with an **append-only
  transition log** + an **effective-status fold**, then adding `reopened` on top.
- **Builds on** escalation resolution ([[escalation-resolution]], ADR 0027), the multi-turn reply thread
  ([[multi-turn-reply-thread]], ADR 0034 — the composite-key + high-water-`seq` pattern reused here),
  guest-reply correlation ([[guest-reply-thread-correlation]], ADR 0035 — the inbound selector this fold
  feeds), and the escalation inbox ([[guest-escalation-inbox]], ADR 0026).
- **Explicitly deferred (recorded):** (1) GUEST-follow-up *auto*-reopen — an inbound `escalated` follow-up
  reopening a still-`resolved` escalation (Phase 37); this phase adds no NEW inbound routing and keeps the
  delicate inbound no-oracle surface untouched. (2) An interim consequence falls out of (1): because Phase-37
  is not built, a guest whose follow-up arrives *before* an operator reopens still opens a **separate** new
  escalation — so a reopened escalation can coexist with a fresh one for the same guest+wedding. Phase-37
  closes this; it is a known, intended interim state, not a regression.

## Context

The resolution log was designed as the single terminal "handled" marker: one record per `escalation_id`,
read-first-put-if-absent, first-writer-wins, status ∈ {resolved, dismissed}, "re-opening is a deferred future
rung" (ADR 0027, schema prose). The inbox's Open/Handled split, the home open-count, the inbound correlation
selector, and the reply gate all read "a resolution row exists ⇒ handled."

The product need: a guest's conversation should not be stuck closed. An operator should be able to reopen.
But a correct reopen requires **re-resolve after reopen** to work too (resolve → reopen → reply → resolve
again), which a single first-writer-wins record cannot represent. So the model itself had to change.

## Decision

**The resolution log becomes an append-only TRANSITION log; effective status is a fold.** Each
`escalation_resolution` row is now ONE transition event, keyed by the composite `${escalation_id}:${seq}`
(mirroring `escalation_reply`), `seq` **server-allocated** as `max(existing)+1`. The schema gains `seq`
(`integer ≥ 0`) and `status` gains `reopened` (a MODIFY — manifest stays **21**). An escalation's **effective
status** = the status of its **highest-`seq`** row: none OR a `reopened` max-`seq` ⇒ `open`; a
`resolved`/`dismissed` max-`seq` ⇒ that handled status.

**Directional no-op idempotency — no client seq, no nonce.** `transition()` appends only when it changes the
machine in a legal direction: `resolved`/`dismissed` append IFF the escalation is currently effective-`open`
(so the FIRST handling sticks — the old first-writer-wins, preserved; resolve→dismiss is a no-op); `reopened`
appends IFF currently effective-HANDLED (a reopen of an open escalation is a no-op). An out-of-direction call
returns `undefined` (the desired state already holds). The read-then-append is ONE synchronous critical
section (no `await`), so a concurrent double-submit cannot double-append — the Phase-31 `settleBalance`
argument. This is DELIBERATELY a different idempotency model from `escalation_reply`'s client-`seq`+409: a
reply carries a distinguishable free-form `body` (a same-seq/different-body race is a genuine lost update → an
honest 409), whereas a transition is a 3-value enum with nothing to lose, so collapsing every double-submit to
one row is correct and a 409 would invent a conflict that doesn't exist. Server-allocated `seq` is also
strictly safer than the reply log's client `seq` — it is not even the inert-client-key surface.

**Reopen rides the EXISTING surface.** `status=reopened` joins the `handleEscalationResolve` enum (the inline
masked-400 enum check still fires before the lookup) and is dispatched by the same `POST /t/:slug/escalations`
+ the same `/escalations/resolve` web form (which forwards `status` verbatim with no `reply_text`, so it
routes to resolve, not reply) — **no new JSON or web route**. The response body is the **uniform
`{resolved:true}`** for all three statuses ("the transition took effect"), matching the frozen
`{resolved:false}` miss key. The page renders a **Reopen** CSRF form on each handled row.

**Every "handled?" reader moved to the fold.** The reply gate (`effectiveStatus !== 'open'`), the inbound
correlation selector (`effectiveStatus === 'open'`), the inbox open/handled split + home open-count
(`effectiveTransitionByEscalation` max-`seq` fold + `isEffectiveOpen`, NOT `new Map(...)` last-in-array). The
`MessagingHandlerDeps.resolutions` Pick narrowed from `getByEscalationId` to `effectiveStatus`.

## Consequences

- **The dismissed-no-bill keystone is now CONDITIONAL, not terminal (doddy P1-1).** Phase 28 guaranteed "a
  `dismissed` escalation can NEVER dispatch a billed message." It now reads "a *currently-handled* (effective
  resolved/dismissed) escalation never dispatches a billed message; an explicit operator reopen returns it to
  open and re-enables billed replies." The gate is still enforced for any currently-handled escalation; reopen
  is operator-gated + CSRF-protected. Tested: dismiss → reply blocked → reopen → reply sends exactly one.
- **One guest-facing consequence, documented + tested (doddy P1-2).** Because the inbound selector matches
  effective-open, once an operator reopens a handled escalation a subsequent guest follow-up threads INTO it
  via the EXISTING Phase-35 selector (still 202, no send/charge, dual-match `from_ref ∧ live wedding_id`).
  This is a safe composition of operator-reopen + the existing selector, NOT new inbound logic — but it is
  guest-observable-in-effect, so it is tested, not hidden. (This is distinct from Phase-37's auto-reopen,
  where the *inbound message itself* would reopen a still-resolved escalation.)
- **No new oracle.** Reopen is operator-only via the same `manageScope` gate; absent / couple-foreign-wedding
  both return the byte-identical `RESP_RESOLVE_MISS` before any write. `wedding_id`/`resolved_by`/`resolved_at`
  /`seq` are all server/trusted-sourced on every transition (a body-smuggled field is inert).
- **`reopened` is structurally unreachable as a handled badge.** A reopened escalation is effective-open → it
  renders in the OPEN column; the handled badge only ever reads resolved/dismissed.
- **Naming kept, prose rewritten (architect P1-3).** The type `EscalationResolution` / fields
  `resolved_by`/`resolved_at`/`resolution_id` are kept (audit-only, never read for a decision; a rename
  cascades through schema + generated type + handlers + render + 10+ fixtures with zero safety benefit). The
  schema description AND the log's `@canonical` header were rewritten — the stale "terminal / first-writer-wins
  / re-opening is a deferred rung" prose is the EXACT invariant this phase deletes and would mislead.
- **The read returns the full transition history.** A couple now sees their own wedding's transition rows
  (resolve/reopen/re-resolve) in the scoped `resolutions` array — in-scope, low-sensitivity audit data, still
  wedding-filtered on every row.

## Verification

`npm run build && npm test && npm run lint` green — 983 tests (up from 970 at the start of Phase 36). doddy +
rigorous-architect lenses reviewed the design (Step 0): both APPROVE-WITH-FIXES, all P1/P2 folded before code
(keystone-conditional restated + tested, the guest-followup consequence documented + tested, max-`seq` fold
not last-in-array, `.ts` prose rewrite, uniform `{resolved:true}`, the named test-migration breakages). The
named specialist sub-agents are not provisioned here; reviews ran through `general-purpose` agents carrying the
persona lens (as Phases 34/35 did).
