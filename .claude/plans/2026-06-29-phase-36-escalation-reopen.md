# Phase 36 — Escalation status-transition model + operator reopen

## Goal

Let a HANDLED guest escalation (`resolved`/`dismissed`) return to the **Open** inbox via an explicit
operator **reopen** action, so an operator who closed a question prematurely (or wants to send another
reply turn) can re-open it instead of being stuck. This closes the *first half* of the Phase-35 deferral
([[guest-reply-thread-correlation]] "Reopen / re-route a resolved escalation").

The blocker Phase 35 named: the resolution log is **single-record, first-writer-wins, terminal** — it
carries no status-transition model. This phase replaces that with an **append-only transition log** (the
proven `EscalationReplyLog` composite-key pattern) + an **effective-status fold**, then adds the reopen
action on top.

**Explicitly deferred to a follow-on (Phase 37):** GUEST-follow-up *auto*-reopen (an inbound `escalated`
follow-up reopens a still-`resolved` escalation). That touches the delicate inbound no-oracle/routing surface;
keeping it out bounds this phase's blast radius. Operator-reopen exercises the FULL transition model
(resolve → reopen → re-resolve) end-to-end with no NEW inbound routing.

**One intended guest-facing consequence (review fix — doddy P1-2; NOT "zero guest-facing change").** Because the
inbound selector matches `effectiveStatus === 'open'`, once an operator reopens a handled escalation it becomes
effective-open and the EXISTING Phase-35 selector will thread a subsequent guest follow-up into it (still 202,
no send/charge, dual-match `from_ref ∧ live wedding_id`). This is a safe *composition* of operator-reopen +
the existing selector, NOT new inbound logic — but it IS guest-observable-in-effect, so it is documented and
TESTED here, not hidden.

## The design

### The model: append-only transition log + effective-status fold

`escalation_resolution` stops being "the one terminal handled record" and becomes "**one transition event**
in an escalation's status history". Effective status = the status of the **highest-`seq`** transition for
that escalation_id (none → `open`; a `reopened` max-seq → `open`; `resolved`/`dismissed` max-seq → handled).

- **Schema MODIFY** (`escalation_resolution_schema.json`, an EXISTING schema ⇒ manifest stays **21**, run
  `gen:types`, no manifest-count bump): add `seq` (`integer`, `minimum:0`, **server-allocated** transition
  position — the composite storage key becomes `${escalation_id}:${seq}`, mirroring `escalation_reply`);
  `status` enum gains `reopened`. Rewrite the title/`status`/`seq` descriptions: no longer terminal /
  first-writer-wins — it is now an append-only transition; effective status = max-`seq` entry. Keep field
  names `resolved_by`/`resolved_at`/type `EscalationResolution`/`resolution_id` (audit-only, never read for a
  decision; a rename cascades through schema + generated type + 3 handlers + render + 10+ test fixtures with
  ZERO safety benefit — both review lenses recommend KEEP-and-document) and document that on a `reopened`
  transition they mean "the actor/time of THIS transition". `wedding_id` is COPIED from the live escalation on
  EVERY transition (incl. reopen) so every transition row carries the couple-scope filter key (doddy P2-1).
- **Prose-rewrite obligation (architect P1-3):** the schema rewrite is NOT enough — the `.ts` `@canonical`
  header of `escalation_resolution_log.ts` (lines ~7-20, 64-70) currently asserts "terminal", "first-writer-
  wins", "re-opening … is a deferred future rung" — the EXACT invariant this phase deletes. It is the
  code-level agent's primary reference; rewrite it in lockstep with the schema or it actively misleads.

- **`EscalationResolutionLog`** (`escalation_resolution_log.ts`): repo keyed by `${escalation_id}:${seq}`
  (was `escalation_id`). Replace `resolve()` with `transition(context, {escalation_id, wedding_id, status,
  by})`:
  - Compute current `effectiveStatus(escalation_id)` over the escalation's transitions.
  - **Directional no-op idempotency** (no client `seq`, no nonce store — the read+append is ONE synchronous
    critical section, the Phase-31 `settleBalance` argument): `resolved`/`dismissed` append **iff** current
    effective is `open` (else no-op — this PRESERVES the old first-writer-wins for resolve/dismiss);
    `reopened` appends **iff** current effective is handled (`resolved`|`dismissed`, else no-op). A
    double-submitted reopen sees the already-open state on the 2nd call → no-op. So resolve→reopen→resolve
    works; every double-click is idempotent in EFFECT and adds no duplicate row.
  - Allocate `seq = max(existing seq)+1` (0 if none) — like `recordGuestReply`'s high-water mark, never
    `count`.
  - Add `effectiveStatus(context, escalation_id): 'open' | 'resolved' | 'dismissed'` (the fold) and
    `effectiveTransition(context, escalation_id): EscalationResolution | undefined` (the max-`seq` record,
    for the page badge). REMOVE `getByEscalationId` (its callers move to `effectiveStatus`).
  - `list`/`listForWedding` unchanged in shape (return ALL transition records; consumers fold).

### Call-site migration (every "resolution exists ⇒ handled" reader → the fold)

- **Reply gate** (`handleEscalationReply`): `getByEscalationId !== undefined` → `effectiveStatus(id) !==
  'open'`. So a REOPENED escalation (effective `open`) again allows reply turns — the point of reopen.
  **Keystone change (doddy P1-1):** the Phase-28 dismissed-no-bill keystone was "a `dismissed` escalation can
  NEVER dispatch a billed message" (terminal). It is now CONDITIONAL: "a *currently-handled* (effective
  resolved/dismissed) escalation never dispatches a billed message; an explicit operator reopen returns it to
  open and re-enables billed replies." Restate it in the reply-gate comment + schema; TEST dismiss → reply
  blocked → reopen → reply now sends exactly one billed message.
- **Resolve handler** (`handleEscalationResolve`): accept `status ∈ {resolved, dismissed, reopened}` (the
  inline enum check, still fired BEFORE the lookup so a bad status is a masked 400 independent of
  existence). Absent / couple-foreign-wedding → the SAME frozen `RESP_RESOLVE_MISS` as today (byte-identical,
  no cross-wedding oracle, before any write — UNCHANGED). Else `transition()`. Success body: **uniform
  `{resolved:true}` for ALL three statuses** (architect P2-4 — "the resolve-route mutation took effect";
  matches the frozen `{resolved:false}` miss key; the web form ignores the body — PRG redirect; only tests
  read it). No new response constant.
- **Selector** (`mostRecentOpenEscalationForGuest`, inbound): `getByEscalationId === undefined` →
  `effectiveStatus(id) === 'open'`. No NEW inbound routing — but see the documented consequence above: an
  operator-reopened escalation is effective-open, so a later guest follow-up threads into it via this
  unchanged selector (test it).
- **`MessagingHandlerDeps.resolutions`** Pick-narrow: `getByEscalationId` → `effectiveStatus`.
- **Page** (`pages.ts`): replace `resolutionIndex` (Map escalation_id→single record) with a fold
  `effectiveStatusByEscalation(resolutions)` → Map escalation_id→`{status, record}` selecting the **max-`seq`**
  row per escalation_id — **NOT** `new Map(resolutions.map(...))` last-in-array-wins, which would mislabel a
  reopened escalation depending on array order (doddy P2-2 / architect §2). `countOpenEscalations`: open =
  effective `open` (no transition OR max-`seq` `reopened`) — caller `product_web_ui.ts:236` is an unchanged
  call with new fold semantics (architect P2-8). `renderEscalations`: open/handled split derived from
  `effectiveStatus`; the handled badge reads the effective (max-`seq`) record's `status`/`resolved_by` — and
  `reopened` is STRUCTURALLY UNREACHABLE as a badge value (a reopened escalation is effective-open → it renders
  in the OPEN column, never the handled-badge path; pin this so no future agent adds a dead/mislabeling
  `reopened` badge — architect P2-5). Add a **Reopen** CSRF form on each HANDLED row (posts `status=reopened`
  to the EXISTING `/t/:slug/escalations/resolve` web route — `#escalationResolve` forwards `status` verbatim
  with NO `reply_text`, so it routes to resolve not reply; **no new web route**, pin the routing — doddy P2-3).

### Why no new oracle / safety preserved

- Reopen is operator-only, gated by the SAME `manageScope` (couple → only their wedding; planner → tenant);
  every miss returns the byte-identical `RESP_RESOLVE_MISS` BEFORE any write. No guest-facing change at all.
- `seq` is **server-allocated** (not client) ⇒ not even the inert-key surface the reply `seq` is; trusted
  state only (`wedding_id` copied from the live escalation, `by` from `principal.role`, `at` clock-stamped).
- Append-only invariant PRESERVED (transitions never mutate a record; the escalation stays immutable). The
  first-writer-wins property is preserved for resolve/dismiss by the directional no-op rule; reopen is the
  ONLY new transition and only from a handled state.

## Steps

- [x] **Step 0 — Design review.** Routed through two `general-purpose` agents (doddy + rigorous-architect
  lenses). Both **APPROVE-WITH-FIXES** — no design flaws; fixes were honesty/prose/test-coverage. All P1 + P2
  findings folded into the prose and Steps above (keystone-conditional, the documented guest-followup
  consequence, max-`seq` fold not last-in-array, `.ts` prose rewrite, uniform `{resolved:true}` body, the
  named test-migration breakages). Commit the plan.
- [x] **Step 1 — Schema + types.** MODIFY `escalation_resolution_schema.json` (add `seq`, status enum +=
  `reopened`, rewrite descriptions). `npm run gen:types`. Verify build/test/lint green (existing tests still
  compile against the new optional-on-read shape; `seq` is required so update fixtures as needed).
- [x] **Step 2 — Transition log.** Rework `EscalationResolutionLog`: composite key, `transition()` with the
  directional no-op rule + `max+1` seq, `effectiveStatus()`, `effectiveTransition()`, remove
  `getByEscalationId`, rewrite the `@canonical` header prose. Update its unit tests
  (`escalation_resolution_log.test.ts`): resolve→reopen→re-resolve, double-submit idempotency, reopen-from-
  dismissed, **resolve→dismiss is a no-op** (directional rule preserves first-writer-wins for the handled
  status — architect P2-6), effectiveStatus fold (empty→open, reopened-max→open), tenant + per-wedding
  isolation on the MULTI-ROW shape (doddy P2-1). Green.
- [x] **Step 3 — Handlers + deps.** `product_api.ts`: enum += `reopened` in `handleEscalationResolve` +
  `transition()` call + uniform `{resolved:true}` body; reply gate + selector → `effectiveStatus`; narrow
  `MessagingHandlerDeps.resolutions` to `effectiveStatus`. `compose.ts` wiring (same instance, new Pick).
  **Migration breakage to fix (architect P1-1/P1-2):** `messaging_inbound_keystone.test.ts` calls
  `resolutions.resolve(...)` directly → rename to `transition(...)` (won't compile otherwise);
  `escalation_resolve_api.test.ts` `toHaveLength(1)` (~:158/:232) + any `resolutions[0]`/count assertions now
  span a multi-row transition history — update them. New handler tests: reopen transitions a handled
  escalation to open; **dismiss → reply blocked → reopen → reply sends exactly one billed message** (doddy
  P1-1 keystone-conditional); miss byte-identical; couple-foreign-wedding reopen masked; planner reopen any;
  guest follow-up after an operator reopen threads into the reopened escalation (doddy P1-2, still 202/no
  charge). Green.
- [x] **Step 4 — Page + web.** `pages.ts`: `effectiveStatusByEscalation` max-`seq` fold, `countOpenEscalations`
  + `renderEscalations` on the fold, Reopen button on handled rows (CSRF). No new web route. Update/extend page
  + e2e tests: a `[resolved@0, reopened@1]` escalation renders in OPEN + increments the open count, `[…,
  dismissed@2]` renders Handled (doddy P2-2 ordering); Reopen button present on handled, absent on open; Reopen
  form forwards no `reply_text` and routes to resolve (doddy P2-3); full browser resolve→reopen→reply loop. Green.
- [x] **Step 5 — Docs.** ADR 0036 (include the architect P2-7 note: an interim Phase-36 state allows a
  reopened escalation to coexist with a separate new escalation for the same guest — Phase-37 auto-reopen
  closes this); memory `[[escalation-status-transition-model]]` + MEMORY.md index; update this plan's boxes;
  refresh `.claude/handoff.local.md` (Phase 36 complete, Phase 37 = guest-follow-up auto-reopen as the next
  lever). Commit.

## Verification

`npm run build && npm test && npm run lint` green before every box tick and commit (run build/lint standalone,
check exit codes — never pipe through tail/grep when `&&`-gating). Per-step commits on
`build/phase-36-escalation-reopen`.
