# Handoff

## Where things stand — Phase 37 (guest-follow-up AUTO-reopen) is COMPLETE ✅
`.claude/plans/2026-06-29-phase-37-guest-followup-auto-reopen.md` is **complete — Step 0 design review (doddy +
architect lenses, APPROVE-WITH-FIXES, all folded) + Steps 1–4**, on branch
**`build/phase-37-guest-followup-auto-reopen`** (off the open review-artifact stack toward `main`; the loop's
merge-keeper advances `main` when green). Working tree clean. `npm run build && npm test && npm run lint` all
green (**989 tests**, up from 983 at the start of this run). A doddy lens re-reviewed the BUILT code: **APPROVE**
(all 7 attacked properties hold, no P0/P1/P2).

This rung closes the SECOND half of the Phase-35 deferral ([[guest-reply-thread-correlation]]): an inbound
`escalated` guest follow-up whose most-recent escalation (in the CURRENTLY-BOUND wedding) is effective-`resolved`
now AUTO-REOPENS it (`transition('reopened', by:'guest')`) and threads in, instead of opening a fresh escalation.
A guest re-engaging a closed conversation continues ONE thread. ADR 0037, memory [[guest-followup-auto-reopen]].

## What changed this phase (commits on the branch)
- **Step 0** — design review (doddy + architect lenses via general-purpose): APPROVE-WITH-FIXES, all folded into
  the steps (reopen-before-thread ordering + test, transition-throw→400-not-500 framing, `guest`-confined-to-
  `reopened` pin, dismissed-no-`reopened`-row test, ADR scope narrowing, per-tier selector header, adversarial
  re-delivery-after-reopen test).
- **Step 1** (commit `2870779`) — `escalation_resolution` schema MODIFY: `resolved_by` enum `+= "guest"`,
  description pins `guest`-only-on-`reopened` (arch P2-C). `gen:types`. Manifest stays **21**.
- **Step 2** (commit `eabc4a3`) — `product_api.ts`: the inbound `escalated` branch routes by effective status
  (open → thread; else resolved → auto-reopen THEN thread; else fresh). Generalized the Phase-35 selector to
  `mostRecentEscalationForGuest(...,status)` called twice (`openTarget ?? resolvedTarget`). Widened
  `MessagingHandlerDeps.resolutions` Pick to `'effectiveStatus' | 'transition'`. Refreshed §B0/selector +
  `compose.ts` comments. Migrated the one Phase-35 test that asserted the old "resolved → fresh" behavior.
- **Step 3** (commit `93e6408`) — tests: dismissed→fresh+no-`reopened`-row, §B0 re-delivery-after-reopen
  (one `reopened` row + one guest turn), OPEN-preferred-over-RESOLVED, `guest`-confined-to-`reopened`
  (arch P2-C), reply-gate-re-enabled-by-a-GUEST-follow-up (one billed send), page renders guest-reopened OPEN.
- **Step 4** — ADR 0037, memory [[guest-followup-auto-reopen]] + index, this handoff.

## The load-bearing insights (carry forward) — see [[guest-followup-auto-reopen]] for the full set
- **The reopen-candidate POLICY lives in the SELECTOR, not in `transition()`.** `transition()`'s directional
  rule appends `reopened` from ANY effective-HANDLED state (resolved OR dismissed), so it would happily reopen a
  dismissed escalation. DISMISSED stays closed because the selector is only ever called with `'open'` then
  `'resolved'` — never `'dismissed'`. Keep policy in the selector; keep `transition()` a clean status primitive.
- **`resolved_by:'guest'` is BOTH honest provenance AND a uniform-202 enabler.** The inbound `escalated` branch
  is NOT try/caught, so a `transition()` contract-validation throw would be a 500/400 oracle. The enum add makes
  the auto-reopen row valid so it never throws. `guest` is confined to `reopened` rows by the only writer
  hard-coding `status:'reopened'` (operator writes `by: principal.role`); a guest-reopened escalation renders
  OPEN so the handled badge (sole `resolved_by` render site) never displays it.
- **Reopen STRICTLY before thread, in the ONE §B0-gated synchronous block.** A threaded guest turn is never
  observed on a still-effective-resolved escalation; the two writes are inseparable (re-delivery replays both or
  neither).
- **Process-once survives the SELECTOR TIER CHANGE.** After the first delivery auto-reopens, a re-delivery of the
  same follow-up is now in the OPEN tier (not resolved) — but §B0 (`getByProviderRef ∧ guestTurnByProviderRef`)
  reads "already processed?" BEFORE routing, so it no-ops the whole branch regardless of tier.

## Next action — your call. Pick the next high-value lever (ranked)
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (the `recipient_ref` tenant-global-key
  collision: a couple-register of a ref already bound to ANOTHER wedding would 409-leak cross-wedding existence).
  A real design pass; may land as a documented "stays deferred" rather than a feature. Coherent, design-heavy.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller, clean, lower product value.
- **Per-period billing windows / statements** — group activity into billing periods/invoices (needs a period
  model the ledger doesn't carry). Medium; defer until a product reason.
- **Guest-conversation transcript surface** — the inbox now holds reopen + multi-turn threads; a couple/planner
  view of the FULL chronological conversation (escalation question + reply turns + transition history,
  interleaved by time) would make the bi-directional channel legible. Pure render-time composition over the
  existing scoped reads (like the Phase-33 home), no new schema. Coherent product rung.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has
  open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not
provisioned** here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this
run did, design AND built-code — both APPROVE). **CI/exit-code lesson:** never pipe `npm run build`/`npm run
lint` to tail/grep when gating with `&&` (the pipe masks the non-zero exit). NOTE: this is **zsh** — `PIPESTATUS`
is not set; use `cmd > /tmp/x.log 2>&1; echo $?` or zsh's `$pipestatus` (1-indexed). `npm run build` runs from
REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by
reachability). **Schema MODIFY ⇒ `npm run gen:types`** (a NEW schema file additionally bumps the manifest count
test + title prose + the gen-script header — Phase 37 only MODIFIED `escalation_resolution`, so the manifest is
still **21**). **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.**
**Web-form mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable).
**The web UI's ONLY data path is `api.handle()`.** **Guest/manage/billing scope comes from the MINTED
principal/context, never the request body; a guest is UNTRUSTED (no Principal) bound to ONE wedding by the
registry.** **When a side-effect splits across two logs by a runtime decision, dedup across BOTH before the write
(§B0).** **A client/provider-controlled value used as a tenant-partitioned KEY is safe (inert-or-self-harm); a
value used to SELECT a routing target must intersect TRUSTED axes (from_ref ∧ live binding.wedding_id), never a
body field.** **A status MACHINE over an append-only log = effective-status FOLD over the highest-`seq`
transition; directional no-op for idempotency, NOT a client seq — unlike a true append (escalation_reply) which
needs the client seq + a 409 lost-update arbiter.** **A reopen-candidate / routing POLICY belongs in the
SELECTOR, not in the status primitive (`transition()` is permissive by design — Phase 37).**
