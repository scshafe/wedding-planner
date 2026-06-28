# Handoff

## Where things stand — Phase 28 (reply-from-the-inbox) is COMPLETE ✅
`.claude/plans/2026-06-28-phase-28-reply-from-inbox.md` is **complete — Step 0 design review + Steps 1–4
ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3–28
build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**858 tests**, up from 844 at the start of this run).

This rung makes the Phase-26/27 escalation inbox **answerable**: the couple (their wedding) / planner (whole
tenant) types a reply to an escalated guest, and the platform sends it to the guest's `from_ref` over the
guest's channel through `MessagingService.send` (**metered + billed — the FIRST console-initiated send**, not
the inbound webhook) and **auto-records a `resolved` resolution** (resolve-by-replying). The guest↔couple↔guest
loop is now fully closeable from the console. doddy + architect APPROVE-WITH-FIXES on the design (no exploit);
**doddy re-review of the BUILT code: APPROVE, clean** (all fixes applied). ADR 0028, memory [[reply-from-inbox]].

## What changed this phase
- **`guest_escalation` schema gains a REQUIRED `channel`** (canonical `Channel`) — the reply-routing snapshot,
  copied from the validated inbound `message.channel` at `record()` time. MODIFY not new (manifest stays 20);
  `gen:types` emits it; `RecordEscalationInput` + the inbound capture site pass it; `channel.test.ts` gains the
  `GuestEscalation['channel']` drift guard.
- **`product_api.ts`** — `dispatchEscalations` POST now discriminates `reply_text !== undefined` → the new
  `handleEscalationReply` (else the Phase-27 `handleEscalationResolve`, refactored to take the parsed `body`).
  `handleEscalationReply`: scope → requireString escalation_id+reply_text (+`REPLY_TEXT_MAX_LENGTH` cap, 400
  before lookup) → `getByEscalationId` → absent OR couple-foreign-wedding → shared frozen `RESP_REPLY_MISS` →
  **already-handled (a resolution exists) → RESP_REPLY_MISS, no send** → `service.send` (channel/from_ref from
  the LIVE escalation, deterministic key `reply:${escalation_id}`) → on success `resolutions.resolve(status
  resolved)` → `{replied:true}`. Commit-after-success; structured send failure → RESP_REPLY_MISS (Open+retryable).
- **`escalation_resolution_log.ts`** — new `getByEscalationId` (O(1) read of the escalation_id-keyed partition),
  the prior-resolution gate.
- **`EscalationHandlerDeps`** gains `service: MessagingService` (REQUIRED; same instance wired at `compose`);
  doc comment updated (now READ-WRITE, no longer "read-only MINIMAL").
- **`pages.ts` + `product_web_ui.ts`** — `renderEscalations` adds a Reply form (textarea + the channel shown)
  to each Open row; new 4-seg `POST /t/:slug/escalations/reply` web route (slug-mask → CSRF → delegate to the
  3-seg JSON route → 303). CSRF at the web layer only.
- **Tests** — `escalation_reply_api.test.ts` (NEW, 8: planner-any/couple-theirs/channel-honored/no-oracle
  byte-identical miss + no send/single-charge double-submit/dismissed-can't-reply/malformed-400-independent-of-
  existence/tenant-isolation); `escalation_web.test.ts` +4 (reply form present / valid reply sends+Handled /
  forged-CSRF no send / unknown-slug 404-before-CSRF); `pages.test.ts` (+reply form + `via sms`);
  `compose.test.ts` +1 e2e (guest texts → escalated → couple replies via the browser → metered send over the
  ask channel → Handled → re-reply single-send no-op); the 3 manual-deps test worlds gain `service`.

## The load-bearing insight (carry forward) — see [[reply-from-inbox]] for the full set
- **The send is gated on NO prior resolution existing** (reached AFTER the scope gate, so not an oracle): an
  already-dismissed escalation never dispatches a billed message; a double-submit is a single send.
- **Absent / couple-foreign-wedding / already-handled ALL return ONE shared frozen `RESP_REPLY_MISS` before
  any send/charge/record** — byte-identity is STRUCTURAL. Separate constant from `RESP_RESOLVE_MISS`.
- **Single-charge is also structural via the DETERMINISTIC meter key `reply:${escalation_id}`** (defense in
  depth; disjoint from the inbound `mintReplyId()` namespace; tenant-scoped).
- **Body reads ONLY escalation_id + reply_text**; channel/recipient/wedding_id/tenant_id from the live
  escalation / context / principal (a smuggled body field is inert). Commit-after-success (send then resolve).
- **Channel is GUEST-chosen** → a cost-amplification bounded by the strict-margin gate (refuses a
  non-positive-margin send). Reply content not persisted; reply can't re-open a handled escalation; both deferred.

## Next action — your call. Pick the next high-value lever (ranked)
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (per-wedding `recipient_ref`
  namespacing OR masked-conflict semantics that doesn't corrupt the planner path). The most-cited open
  product-authz deferral. Medium; needs a real design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller.
- **A reply transcript / conversation thread** — persist what the operator replied (Phase 28 deferred it: the
  meter records that a send happened, not its content), so the inbox shows the back-and-forth. New schema +
  read surface; medium. Naturally extends [[reply-from-inbox]].
- **Auto-resolve on fill** — automatically mark an escalation resolved when the couple fills the matching fact.
  Needs an escalation→field link the record lacks (a `topic`/field tag); deferred with the `topic` field.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline)
  has open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not
provisioned** here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this
run did, at design AND on the built code — all APPROVE, no exploit). **CI/exit-code lesson:** never pipe `npm
run build` to tail/grep when gating with `&&` (the pipe masks the non-zero exit); run build standalone, check
`$?`. `npm run build` runs from REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`,
never `product`** (the firewall, by reachability). **Schema change ⇒ `npm run gen:types`**; a NEW schema file
additionally bumps the manifest count test (+ title prose) + the gen-script header — Phase 28 only MODIFIED the
20th schema (added `channel`), so the manifest stays 20. **The guest responder's security boundary is
`projectGuestVisibleFacts`'s allow-list.** **Web-form mutations are CSRF-gated at the web layer ONLY** (the JSON
API is Bearer-only / not CSRF-reachable); a body value placed into a request URL path MUST be
`encodeURIComponent`'d. **The web UI's ONLY data path is `api.handle()`** — a new page/form DELEGATES through a
JSON route, never holds the store. **Guest/manage scope comes from the MINTED principal, never the request
body.** **A scoped mutation that must be oracle-free returns ONE shared frozen miss constant on every miss
branch** (Phase 27 `RESP_RESOLVE_MISS`, Phase 28 `RESP_REPLY_MISS`). **A console-initiated metered send gates on
NO prior resolution + a deterministic per-escalation meter key** (Phase 28); the bill is ALWAYS metered from
OUR send record, never the provider (the Phase-18 firewall).
