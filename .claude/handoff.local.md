# Handoff

## Where things stand — Phase 35 (guest-reply → thread correlation) is COMPLETE ✅
`.claude/plans/2026-06-29-phase-35-guest-reply-correlation.md` is **complete — Step 0 design review (both
lenses APPROVE-WITH-FIXES) + Steps 1–4 implementation + Step 5 docs**, on branch
**`build/phase-35-guest-reply-correlation`** (off `build/phase-34-multi-turn-reply-thread`, the open
review-artifact stack toward `main`; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**970 tests**, up from 953 at the start of this run).

This rung makes the guest-escalation inbox **bi-directional**. Until now every inbound guest message the
platform couldn't answer (`escalated`) opened a FRESH escalation — a follow-up from a guest with an open
question spawned a *second* escalation. Now an `escalated` follow-up from a guest who already has an OPEN
escalation in their CURRENTLY-BOUND wedding **threads into that escalation** as a `sender:'guest'` turn (no
send, no charge — only operator replies meter). Correlation is INFERRED server-side (the port has no
conversation id). doddy+architect APPROVE-WITH-FIXES at design; the §B0 routing-instability bug was self-caught
during build (beyond the review). ADR 0035, memory [[guest-reply-thread-correlation]].

## What changed this phase (commits on the branch)
- **Step 0** — design review (doddy + architect lenses via general-purpose): APPROVE-WITH-FIXES, P1s/P2s folded.
- **Steps 1–2** — `escalation_reply` schema MODIFY (manifest stays **21**): `sender` += `guest`; **DROPPED
  `body.maxLength`** (the field now hosts UNBOUNDED untrusted guest input, byte-identical to
  `inbound_webhook.text`/`guest_escalation.text` → no 500 oracle; the operator cost cap moved ENTIRELY to the
  handler `REPLY_BODY_MAX_LENGTH`, the SOLE surviving enforcement); optional `provider_message_ref` with a
  `billing_event`-style allOf if/then/**else** discriminant (required iff `sender:guest`, FORBIDDEN on operator
  turns). `EscalationReplyLog.recordGuestReply` (dedup by ref; slot = `max(seq)+1`, **never `thread.length`** —
  the P1 gap-collision fix) + `guestTurnByProviderRef`; `EscalationLog.getByProviderRef` (O(1), repo keyed by
  ref). Drift guard repurposed (schema body has NO maxLength). `gen:types`.
- **Step 3** — `handleInbound` escalated branch: the §B0 **process-once gate** (getByProviderRef +
  guestTurnByProviderRef, BEFORE routing) → no-op on re-delivery, then thread-vs-fresh via
  `mostRecentOpenEscalationForGuest` (the from_ref ∧ bound-wedding ∧ open ∧ most-recent selector).
  `MessagingHandlerDeps` += `resolutions` (Pick-narrowed to `getByEscalationId`) + `replies`; compose wires the
  same instances. +7 correlation tests.
- **Step 4** — `pages.ts` `threadView`: exhaustive three-way sender label (guest/planner/couple, replacing the
  binary `planner`-else ternary that would mislabel a guest turn as "Couple"). Guest body HTML-escaped. +3 web
  e2e tests.
- **Step 5** — ADR 0035, memory [[guest-reply-thread-correlation]] + index, this handoff.

## The load-bearing insights (carry forward) — see [[guest-reply-thread-correlation]] for the full set
- **THE PROCESS-ONCE GATE was the real correctness fix (self-caught; BOTH review agents missed it).** Split
  routing (thread-or-record) makes a per-thread ref-scan insufficient: a freshly-recorded escalation is OPEN, so
  a re-delivery of the SAME message would otherwise be threaded INTO it (the common break); a resolved escalation
  drops a re-delivered follow-up to a fresh escalation (cross-resolve). FIX: gate the escalated branch on
  `escalations.getByProviderRef(ref)` (O(1)) + `replies.guestTurnByProviderRef(ref)` BEFORE routing — the
  answered-branch `receipts.seen` analogue; no widening of the doddy-P0 receipt log. **GENERAL LESSON: when a
  side-effect splits across two logs by a runtime decision, dedup must be checked across BOTH before the write.**
- **The DUAL match (from_ref AND live `binding.wedding_id`) is the cross-wedding mis-segmentation defense.** A
  re-bound `recipient_ref` (planner moves a guest A→B) carries stale A-escalations; filtering by the LIVE binding
  excludes them, so a re-bound guest's message can only reach an open escalation in their *current* wedding.
- **Guest turn = ref-keyed, slot `max(seq)+1` never `thread.length`.** `thread.length` lands inside a gap a
  forged/sparse operator seq leaves → silent overwrite/drop (both lenses' P1). Operator turn stays seq-keyed
  (form double-submit / 409). Two idempotency models, one composite-slot thread.
- **`escalation_reply.body` is now dual-provenance and UNBOUNDED.** Operator text capped at the handler (cost);
  guest text unbounded at the schema (no 500). A long guest message can never fail validation.
- **No new oracle.** Every inbound branch still returns the uniform 202; threading-vs-fresh is invisible to the
  guest; the threaded path discloses only the guest's OWN conversation state.

## Next action — your call. Pick the next high-value lever (ranked)
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle. THE TENSION: `recipient_ref` is the
  tenant-GLOBAL inbound-lookup partition key, so per-wedding namespacing would BREAK inbound segmentation, AND a
  conflict can't be masked without a correctness cost. A real design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller, clean, lower product value.
- **Reopen / re-route a resolved escalation** — Phase-35 deferral: a guest follow-up after resolve opens a fresh
  escalation; a "reopen" action (or routing a follow-up to reopen) would keep the conversation in one place.
  Needs a status-transition model the resolution log (first-writer-wins, terminal) doesn't carry yet. Medium.
- **Thread the `answered` follow-up** — the other Phase-35 deferral: an auto-answerable follow-up sends but
  doesn't thread / doesn't auto-resolve. Small, but conflates "what the platform auto-said" with operator turns
  (think about the sender model first). Low-medium value.
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
run did, at design — APPROVE-WITH-FIXES, all folded; the §B0 routing-instability fix was self-caught beyond the
review). **CI/exit-code lesson:** never pipe `npm run build`/`npm run lint` to tail/grep when gating with `&&`
(the pipe masks the non-zero exit; use `${PIPESTATUS[0]}`); run them standalone and check the exit. **zsh does
NOT word-split unquoted vars** — use an array for multi-file loops; a grep with embedded newlines is unreliable
(use a Python multiline replace for multi-file edits — this run did). `npm run build` runs from REPO ROOT.
**Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by
reachability). **Schema MODIFY ⇒ `npm run gen:types`** (a NEW schema file additionally bumps the manifest count
test + title prose + the gen-script header — Phase 35 only MODIFIED `escalation_reply`, so the manifest is still
**21**). **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.** **Web-form
mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable). **The web
UI's ONLY data path is `api.handle()`.** **Guest/manage/billing scope comes from the MINTED principal/context,
never the request body; a guest is UNTRUSTED (no Principal) bound to ONE wedding by the registry.** **When a
side-effect splits across two logs by a runtime decision, dedup across BOTH before the write (Phase 35 §B0).**
**A client/provider-controlled value used as a tenant-partitioned KEY is safe (inert-or-self-harm) — `seq`
(34), `provider_message_ref` (26/35) — but a value used to SELECT a routing target (Phase 35 correlation) must
intersect TRUSTED axes (from_ref ∧ live binding.wedding_id), never a body field.**
