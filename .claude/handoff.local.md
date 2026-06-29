# Handoff

## Where things stand — Phase 36 (escalation status-transition model + operator reopen) is COMPLETE ✅
`.claude/plans/2026-06-29-phase-36-escalation-reopen.md` is **complete — Step 0 design review (both lenses
APPROVE-WITH-FIXES) + Steps 1–4 implementation + Step 5 docs**, on branch
**`build/phase-36-escalation-reopen`** (off `build/phase-35-guest-reply-correlation`, the open review-artifact
stack toward `main`; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**983 tests**, up from 970 at the start of this run).

This rung lets a HANDLED guest escalation return to the **Open** inbox. Until now the resolution log was
single-record / first-writer-wins / **terminal** — a resolved or dismissed escalation could never be reopened,
and a guest's conversation could get stuck closed. Phase 36 replaces that with an **append-only TRANSITION log
+ an effective-status fold**, and adds an explicit operator **reopen** action. Closes the *first half* of the
Phase-35 deferral ([[guest-reply-thread-correlation]] "Reopen / re-route a resolved escalation"). doddy +
architect APPROVE-WITH-FIXES at design; all P1/P2 folded before code. ADR 0036, memory
[[escalation-status-transition-model]].

## What changed this phase (commits on the branch)
- **Step 0** — design review (doddy + architect lenses via general-purpose): APPROVE-WITH-FIXES, all P1/P2 folded.
- **Steps 1–3** — `escalation_resolution` schema MODIFY (manifest stays **21**): `+seq` (`integer ≥ 0`,
  **server-allocated** `max+1`, the composite key `${escalation_id}:${seq}`), `status` enum `+reopened`; rewrote
  the description AND the log's `@canonical` header (the stale "terminal/first-writer-wins/reopening is a deferred
  rung" prose was the exact invariant deleted). `EscalationResolutionLog`: `transition()` (replaced `resolve()`),
  `effectiveStatus()`/`effectiveTransition()` fold, removed `getByEscalationId`. `product_api`:
  `handleEscalationResolve` enum `+=reopened` + `transition()` + uniform `{resolved:true}`; reply gate + inbound
  selector → `effectiveStatus`; `MessagingHandlerDeps.resolutions` Pick → `effectiveStatus`. `index.ts` exports
  `RecordTransitionInput`/`EffectiveEscalationStatus`. `gen:types`. Migrated the unit test + keystone/pages tests;
  +reopen handler tests + the keystone-conditional + the guest-followup-after-reopen test.
- **Step 4** — `pages.ts` `effectiveTransitionByEscalation` (MAX-`seq` fold, not last-in-array) + `isEffectiveOpen`;
  `countOpenEscalations` + `renderEscalations` open/handled split on the fold; a reopened escalation renders OPEN;
  a **Reopen** CSRF form on each handled row (posts `status=reopened` to the EXISTING `/escalations/resolve` web
  route — no new route). +page tests + browser resolve→reopen→reply e2e; fixed stale "no resolve action on
  handled" assertions in pages/escalation_web/compose e2e (the Reopen form now posts there).
- **Step 5** — ADR 0036, memory [[escalation-status-transition-model]] + index, this handoff.

## The load-bearing insights (carry forward) — see [[escalation-status-transition-model]] for the full set
- **Directional no-op idempotency — no client seq, no nonce, no 409.** `transition()` appends only in a legal
  direction (`resolved`/`dismissed` from effective-`open`; `reopened` from effective-HANDLED); out-of-direction is
  a `undefined` no-op. The read-then-append is ONE synchronous critical section (the Phase-31 `settleBalance`
  argument), so a double-submit can't double-append. **DELIBERATELY a different model than `escalation_reply`'s
  client-`seq`+409:** a reply carries a free-form `body` (same-seq/different-body = a real lost update → honest
  409); a transition is a 3-value enum with nothing to lose, so collapsing every double-submit to one row is
  correct. Server `seq` is strictly safer than the reply's client `seq` (not even the inert-client-key surface).
- **The dismissed-no-bill keystone is now CONDITIONAL, not terminal.** "A *currently-handled* (effective
  resolved/dismissed) escalation never dispatches a billed message; an explicit operator reopen returns it to open
  and re-enables billed replies." The reply gate reads `effectiveStatus !== 'open'`.
- **One documented guest-facing consequence (NOT "zero change").** Once an operator reopens a handled escalation
  it is effective-open, so a later guest follow-up threads INTO it via the EXISTING Phase-35 selector (still 202,
  no send/charge). A safe COMPOSITION of operator-reopen + the existing selector — tested, not hidden. Distinct
  from Phase 37 (where the inbound message *itself* reopens a still-resolved escalation).
- **The page fold MUST use max-`seq`, not last-in-array** (`effectiveTransitionByEscalation` + `isEffectiveOpen`,
  single-sourced for the inbox split AND the home open-count so they can't drift). `reopened` is structurally
  unreachable as a handled badge (effective-open renders in the OPEN column).
- **Reopen rides the existing surface — no new JSON or web route.** `status=reopened` joins the resolve enum;
  same `POST /t/:slug/escalations` + the same `/escalations/resolve` web form (forwards `status`, no `reply_text`).

## Next action — your call. Pick the next high-value lever (ranked)
- **Phase 37 — GUEST-follow-up AUTO-reopen** (the SECOND half of the Phase-35 deferral, now unblocked by the
  transition model). An inbound `escalated` follow-up from a guest whose most-recent escalation is still
  `resolved` would REOPEN it and thread in, instead of opening a fresh escalation. THE DESIGN TENSION: this
  touches the inbound no-oracle/routing surface (the §B0 process-once gate, the selector) — decide reopen-from-
  `resolved` vs from-`dismissed` (a dismissed escalation is a deliberate operator "no" — probably stays closed →
  fresh), and keep the uniform-202/no-oracle property. Natural, coherent, medium. Closes the interim
  coexistence note in ADR 0036.
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (the `recipient_ref` tenant-global-key
  collision). A real design pass; may land as a documented "stays deferred" rather than a feature.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller, clean, lower product value.
- **Per-period billing windows / statements** — group activity into billing periods/invoices (needs a period
  model the ledger doesn't carry). Medium; defer until a product reason.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has
  open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not
provisioned** here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this
run did, at design — APPROVE-WITH-FIXES, all folded). **CI/exit-code lesson:** never pipe `npm run build`/`npm
run lint` to tail/grep when gating with `&&` (the pipe masks the non-zero exit; use `${PIPESTATUS[0]}`); run them
standalone and check the exit. `npm run build` runs from REPO ROOT. **Eval-harness/telemetry import ONLY
`@wedding-planner/shared`, never `product`** (the firewall, by reachability). **Schema MODIFY ⇒ `npm run
gen:types`** (a NEW schema file additionally bumps the manifest count test + title prose + the gen-script header —
Phase 36 only MODIFIED `escalation_resolution`, so the manifest is still **21**). **The guest responder's security
boundary is `projectGuestVisibleFacts`'s allow-list.** **Web-form mutations are CSRF-gated at the web layer
ONLY** (the JSON API is Bearer-only / not CSRF-reachable). **The web UI's ONLY data path is `api.handle()`.**
**Guest/manage/billing scope comes from the MINTED principal/context, never the request body; a guest is
UNTRUSTED (no Principal) bound to ONE wedding by the registry.** **When a side-effect splits across two logs by a
runtime decision, dedup across BOTH before the write (Phase 35 §B0).** **A client/provider-controlled value used
as a tenant-partitioned KEY is safe (inert-or-self-harm); a value used to SELECT a routing target must intersect
TRUSTED axes (from_ref ∧ live binding.wedding_id), never a body field.** **When a side-effect splits across two
logs by a runtime decision, dedup across BOTH before the write.** **A status MACHINE over an append-only log =
effective-status FOLD over the highest-`seq` transition; directional no-op for idempotency, NOT a client seq
(Phase 36) — unlike a true append (escalation_reply) which needs the client seq + a 409 lost-update arbiter.**
