# Handoff

## Where things stand — Phase 38 (guest-conversation transcript surface) is COMPLETE ✅
`.claude/plans/2026-06-30-phase-38-conversation-transcript.md` is **complete — Step 0 design review (doddy +
architect lenses, APPROVE-WITH-FIXES, all folded) + Steps 1–4**, on branch
**`build/phase-38-conversation-transcript`** (off the open review-artifact stack toward `main`; the loop's
merge-keeper advances `main` when green). Working tree clean. `npm run build && npm test && npm run lint` all
green (**1006 tests**, up from 989 at the start of this run). A doddy lens re-reviewed the BUILT code:
**APPROVE** (all 6 attacked properties hold, no P0/P1/P2).

This rung is the read-side legibility companion to the whole Phase 26–37 conversation arc: a READ-ONLY
per-conversation chronological TRANSCRIPT of ONE guest escalation — question + reply turns (operator AND Phase-35
`guest` follow-ups) + status transitions (resolved/dismissed/reopened, who+when), interleaved by time. Route
`GET /t/:slug?view=escalations&conversation=<id>`, linked from each inbox row. A PURE web-layer composition of
the existing scoped `GET /escalations` read — NO new schema/endpoint/domain code (manifest stays **21**). ADR
0038, memory [[guest-conversation-transcript]].

## What changed this phase (commits on the branch)
- **Step 0** — design review (doddy + architect lenses via general-purpose): both APPROVE-WITH-FIXES; settled the
  comparator on the total `(at, G, seq)` tuple after a self-caught non-transitivity in the architect's first
  proposal (architect re-confirmed via a follow-up); masking = themed-200 frozen notice with no id reflection.
- **Step 1** (commit after `52682e6`) — `pages.ts`: `buildConversationTimeline(escalation, resolutions,
  replies)` → discriminated `ConversationEvent[]` ordered by the total lexicographic `(at, G, seq)` tuple;
  `renderConversation` (read-only themed transcript) + `renderConversationNotFound` (frozen themed-200 notice);
  lifted `senderLabel` to module scope; "View full conversation →" links on inbox rows. Unit tests incl. the two
  same-instant tie tests + the characterization test.
- **Step 2** — `product_web_ui.ts`: `#console` routes `?view=escalations&conversation=ID` → `#conversationPage`
  (ONE scoped `GET /escalations` read; select by id from the scoped array; not-found → frozen themed-200 notice;
  theme-undefined → GENERIC_404). Read-only ⇒ no CSRF issuance.
- **Step 3** — web/e2e tests in `escalation_web.test.ts` (exposed `clock` from `makeWorld` so e2e advances time):
  inbox→transcript link, planner interleaved view, end-to-end Phase-37 auto-reopen ordering, no-oracle
  (sibling-wedding id ≡ absent), no id reflection, malformed-id no-500, unauth/unknown-tenant byte-identical mask.
- **Step 4** — ADR 0038, memory [[guest-conversation-transcript]] + index, this handoff.

## The load-bearing insights (carry forward) — see [[guest-conversation-transcript]] for the full set
- **Transcript order = a TOTAL lexicographic tuple `(at, G, seq)`**, `G={question:0,reopened:1,reply:2,
  resolved|dismissed:3}`. Primary `at` is right when the clock advanced (production); the `(G,seq)` tiebreak is
  causally faithful to the two real same-instant flows (Phase-37 reopen-before-guest-reply, Phase-28
  reply-before-close). A context-dependent "same-source-by-seq" rule is NON-TRANSITIVE (a 3-cycle → inconsistent
  JS comparator) — REJECTED. The tuple's one mis-order (same-instant resolved→reopened) is UNREACHABLE (no
  synchronous context writes two transitions; SystemClock advances) — frozen by a characterization test; e2e
  advances the ManualClock between operator actions.
- **The transcript renders RAW history and computes NO effective status** — don't reuse the inbox/home max-seq
  fold; any status summary (if ever added) must come from that fold, never "the last timeline event".
- **No-oracle sub-selection**: `#conversationPage` selects by id FROM the already-scoped array (pure filter key);
  not-in-scope ≡ absent ≡ foreign → a FROZEN THEMED-200 notice with zero id reflection. NOT `GENERIC_404` — the
  read already returned 200 (tenant active); 404 is the unknown-tenant mask = leakier + in-request inconsistent.
- **`buildConversationTimeline` takes the escalation OBJECT** and joins on `escalation.escalation_id` (server
  data), never the client `?conversation=` string.

## Next action — your call. Pick the next high-value lever (ranked)
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (the `recipient_ref` tenant-global-key
  collision: a couple-register of a ref already bound to ANOTHER wedding would 409-leak cross-wedding existence).
  A real design pass; may land as a documented "stays deferred" rather than a feature. Coherent, design-heavy.
- **Reply-on-transcript (the Phase-38 follow-up)** — add the Reply/Resolve/Reopen actions to the transcript page
  (a guest-auto-reopened conversation is effective-open and needs a reply, but actions currently stay on the
  inbox). Re-opens the CSRF surface + needs a PRG-redirect-back-to-conversation; small, coherent, own review.
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
