---
name: escalation-status-transition-model
description: Phase 36 — the escalation resolution log became an append-only transition log (composite key, effective-status fold) + an operator reopen action; the dismissed-no-bill keystone is now conditional
metadata:
  type: project
---

Phase 36 (ADR 0036) replaced the **terminal, single-record, first-writer-wins** escalation resolution model
([[escalation-resolution]], ADR 0027) with an **append-only status-TRANSITION log + effective-status fold**, and
added an explicit operator **reopen** action that returns a HANDLED escalation to the Open inbox. Closes the
first half of the Phase-35 deferral ([[guest-reply-thread-correlation]]). On branch
`build/phase-36-escalation-reopen` off the review-artifact stack toward `main`. 983 tests (was 970).

**The model.** `escalation_resolution` is now ONE transition event, keyed by the composite
`${escalation_id}:${seq}` (the `escalation_reply` pattern reused), `seq` **server-allocated** as `max+1`. Schema
MODIFY: `+seq` (`integer ≥ 0`), `status` enum `+reopened` (manifest stays **21**, `gen:types`). Effective status
= the **highest-`seq`** row's status: none OR `reopened` max-`seq` ⇒ `open`; `resolved`/`dismissed` max-`seq` ⇒
handled. `EscalationResolutionLog`: `transition()` (replaced `resolve()`), `effectiveStatus()`,
`effectiveTransition()`; `getByEscalationId` REMOVED.

**Load-bearing insights (carry forward):**

- **Directional no-op idempotency — no client seq, no nonce, no 409.** `transition()` appends only in a legal
  direction: `resolved`/`dismissed` IFF currently effective-`open` (first handling sticks — old first-writer-
  wins PRESERVED; resolve→dismiss is a no-op); `reopened` IFF currently effective-HANDLED. Out-of-direction →
  `undefined` no-op. The read-then-append is ONE synchronous critical section (the Phase-31 settleBalance
  argument), so a double-submit can't double-append. **This is DELIBERATELY a different idempotency model than
  `escalation_reply`'s client-`seq`+409:** a reply has a distinguishable free-form `body` (same-seq/different-
  body = a real lost update → honest 409); a transition is a 3-value enum with nothing to lose, so collapsing
  every double-submit to one row is correct and a 409 would invent a conflict. Server `seq` is strictly safer
  than the reply's client `seq` (not even the inert-client-key surface).

- **The dismissed-no-bill keystone is now CONDITIONAL, not terminal.** Phase-28's "a `dismissed` escalation can
  NEVER dispatch a billed message" became "a *currently-handled* (effective resolved/dismissed) escalation never
  dispatches a billed message; an explicit operator reopen returns it to open and re-enables billed replies."
  The reply gate reads `effectiveStatus !== 'open'`. Tested: dismiss → blocked → reopen → reply sends exactly one.

- **One documented guest-facing consequence (NOT "zero change").** Because the inbound correlation selector
  matches effective-open, once an operator reopens a handled escalation a later guest follow-up threads INTO it
  via the EXISTING Phase-35 selector (still 202, no send/charge). A safe COMPOSITION of operator-reopen + the
  existing selector, not new inbound logic — tested, not hidden. Distinct from Phase-37 (where the inbound
  message *itself* reopens a still-resolved escalation).

- **Reopen rides the existing surface — no new route.** `status=reopened` joins the `handleEscalationResolve`
  enum; same `POST /t/:slug/escalations` + the same `/escalations/resolve` web form (forwards `status` verbatim,
  no `reply_text` → routes to resolve). Uniform `{resolved:true}` body for all three statuses (matches the
  frozen `{resolved:false}` miss). A Reopen CSRF form on each handled row.

- **The page fold MUST use max-`seq`, not `new Map(...)` last-in-array** (`effectiveTransitionByEscalation` +
  `isEffectiveOpen`, single-sourced for the inbox split AND the home open-count so they can't drift). A reopened
  escalation counts as OPEN. `reopened` is structurally unreachable as a handled badge (effective-open renders
  in the OPEN column). `MessagingHandlerDeps.resolutions` Pick narrowed `getByEscalationId`→`effectiveStatus`.

- **Naming kept, prose rewritten.** `EscalationResolution`/`resolved_by`/`resolved_at`/`resolution_id` kept
  (audit-only; rename = churn with zero safety benefit). The schema description AND the log's `@canonical`
  header were rewritten — the stale "terminal/first-writer-wins/re-opening is a deferred rung" prose is the
  exact invariant deleted and would mislead a future agent.

**Deferred → Phase 37:** GUEST-follow-up auto-reopen (inbound `escalated` follow-up reopens a still-`resolved`
escalation). Until then a guest follow-up arriving before an operator reopens still opens a separate fresh
escalation — a known, intended interim state.

doddy + architect both APPROVE-WITH-FIXES at design (Step 0); all P1/P2 folded before code (specialist
sub-agents not provisioned — persona lens via `general-purpose`, as Phases 34/35).
