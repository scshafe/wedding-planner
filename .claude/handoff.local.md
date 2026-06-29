# Handoff

## Where things stand — Phase 34 (multi-turn console reply thread) is COMPLETE ✅
`.claude/plans/2026-06-28-phase-34-multi-turn-reply-thread.md` is **complete — Step 0 design review + the
implementation (plan Steps 1–3, landed as ONE coherent commit because the schema retirement, the decoupled
handler, and the web form's `seq` are inseparable) + Step 4 docs**, on branch
**`build/phase-34-multi-turn-reply-thread`** (off `build/phase-33-account-home-overview`, the open
review-artifact stack toward `main`; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**953 tests**, up from 945 at the start of this run).

This rung turns the escalation inbox into a **conversation surface**. Until now a console reply (Phase 28) sent
ONE metered message per escalation and AUTO-resolved it — one shot per question. Now a reply **appends to a
per-escalation thread** and meters a send **without resolving**, so an operator can send follow-ups while the
escalation stays OPEN; resolving/dismissing stays the explicit Phase-27 action. doddy+architect APPROVE at BOTH
design (APPROVE-WITH-FIXES, all P1/P2 folded) AND built code (APPROVE — no constructible exploit, 8 properties
verified at file:line). ADR 0034, memory [[multi-turn-reply-thread]].

## What changed this phase
- **21st schema `escalation_reply`** (`{reply_id, tenant_id, escalation_id, wedding_id, seq, sender, body,
  sent_at}`) + `gen:types` + manifest 20→21 (count test, title prose, gen-script header). **Retired**
  `escalation_resolution.reply_text` (+ its `allOf`) — the thread owns the transcript now; a resolution is again
  a pure handled-marker.
- **`escalation_reply_log.ts`** — `EscalationReplyLog`: `TenantScopedRepository` keyed by the composite
  `${escalation_id}:${seq}`; `readSlot` / `append` (read-first-put-if-absent) / `list` / `listForWedding`
  (couple scope, `undefined → []`). Mirrors the resolution log + the `provider_message_ref`-as-key precedent.
- **`product_api.ts`** — `handleEscalationReply` rewritten (PINNED order: scope → escalation_id/reply_text(cap)/
  `seq`(parseSeq) → getByEscalationId absent miss → couple foreign-wedding miss → resolved/dismissed miss →
  `readSlot` (same body=idempotent `{replied:true}`; different body=`409`) → `service.send` key
  `reply:${id}:${seq}` → `replies.append`; **no resolution write**). New `parseSeq` (non-negative int, masked
  400 before the lookup, never defaulted). `handleEscalationList` returns the 3rd scoped `replies` array.
  `EscalationHandlerDeps` gains `replies`. Constant `REPLY_TEXT_MAX_LENGTH` → `REPLY_BODY_MAX_LENGTH`. New
  `RESP_REPLY_CONFLICT` (409). `compose.ts` wires `new EscalationReplyLog(...)`.
- **`pages.ts` / `product_web_ui.ts`** — `renderEscalations(+replies)` renders each escalation's thread
  (`threadsByEscalation`, numeric `seq` sort) on OPEN + HANDLED rows; the reply form carries hidden
  `seq = thread length`. Web `#escalationReply` forwards `seq`; new `readReplies`. `countOpenEscalations` stays
  reply-agnostic.
- **Tests** — new `escalation_reply_log.test.ts` (+8; seq idempotency/numeric-gap/couple-scope/cross-tenant/
  liveness + the MOVED no-500 drift guard); rewrote `escalation_reply_api.test.ts` for decoupled multi-turn
  (stays-open, 2nd reply at seq=1 sends again, same-seq/same-body once, same-seq/different-body 409,
  dismissed/resolved no-bill, existence-independent seq 400, transcript on thread); migrated the web e2e
  (`escalation_web`, `billing_web`, `compose`) + `pages.test`; 5 escalation harnesses gained a `replies` dep.

## The load-bearing insight (carry forward) — see [[multi-turn-reply-thread]] for the full set
- **Decoupling moved the double-submit guard from "a resolution exists" to a render-time `seq`.** The form
  carries `seq = (thread length)`; the log keys on the composite `${escalation_id}:${seq}` (read-first); the
  meter key `reply:${id}:${seq}` is now defense-in-depth. A re-POST of the same form = same seq = one send; a
  fresh form = `seq+1` = a new send.
- **`seq` is a CLIENT-controlled KEY, safe like `provider_message_ref`** — partition is `context.tenant_id`
  ALONE, so a forged seq is inert-or-self-harm (collides only with the caller's own slot), and every new slot
  self-funds a metered send. channel/recipient/wedding_id/escalation_id come from the LIVE escalation.
- **Same-seq / DIFFERENT-body ⇒ `409`, never a silent `{replied:true}`** (doddy P1) — the honest fix for the
  concurrent-distinct-operator collision; no nonce store. Reachable only after scope+open gates ⇒ no oracle.
- **The dismissed-no-bill keystone (Phase 28 F1/F2) STAYS** ahead of the send (no longer the double-submit
  guard, but not dead — a closed escalation never dispatches a billed message).

## Next action — your call. Pick the next high-value lever (ranked)
- **Guest-reply → thread correlation** — the deferred half of multi-turn and the MOST-CITED open thread now: a
  guest texts back and it lands in the OPEN escalation's thread (vs today's "fresh question → fresh
  escalation"). THE DESIGN PROBLEM (real): the provider-agnostic port carries only opaque refs and no
  conversation id — a guest texts in with a `from_ref`, no escalation/thread id. So correlation must be
  inferred (most-recent OPEN escalation for that `from_ref`+wedding? a time window?) WITHOUT a carrier concept
  leaking into the domain and WITHOUT a cross-wedding mis-segmentation (a `from_ref` can be a guest at >1
  wedding — the Phase-24 tenant-global-key tension resurfaces). Medium-large; scope the correlation rule
  carefully (and it's UNTRUSTED guest input landing in a trusted thread → escape + no-oracle discipline).
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle. THE TENSION: `recipient_ref` is the
  tenant-GLOBAL inbound-lookup partition key, so per-wedding namespacing would BREAK inbound segmentation, AND a
  conflict can't be masked without a correctness cost. A real design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller, clean, lower product value.
- **Per-period billing windows / statements** — group the activity into billing periods/invoices (needs a
  period model the ledger doesn't carry yet). Medium; defer until a product reason.
- **Partial / arbitrary-amount payments** — the deferred Phase-31 extension (re-introduces client money input →
  own bounds/no-fraud pass). Defer until a product reason.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has
  open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not
provisioned** here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this
run did, at BOTH design AND built-code — APPROVE, no exploit). **CI/exit-code lesson:** never pipe `npm run
build`/`npm run lint` to tail/grep when gating with `&&` (the pipe masks the non-zero exit; `$?` after a pipe is
the LAST stage's — use `${PIPESTATUS[0]}`); run them standalone and check the exit. **zsh does NOT word-split
unquoted vars** — use an array (`files=(a b c); for f in $files`) for multi-file loops. `npm run build` runs from
REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by
reachability). **Schema change ⇒ `npm run gen:types`**; a NEW schema file additionally bumps the manifest count
test (+ title prose) + the gen-script header — Phase 34 added ONE schema (`escalation_reply`), so the manifest is
now **21**. **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.** **Web-form
mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable). **The web
UI's ONLY data path is `api.handle()`** (Phase 34's `seq` rides the SAME scoped read that renders the page — no
new web dependency). **Guest/manage/billing scope comes from the MINTED principal/context, never the request
body.** **A capability the role lacks entirely (couple→register, couple→billing incl. pay) is a 403 checked
FIRST; a customer-facing PROJECTION/AGGREGATE of trusted records must disclose nothing the parts don't.** **A
coupled validation/price/balance constant MUST be drift-guarded by a test** (Phase 34: `escalation_reply.body`
maxLength == `REPLY_BODY_MAX_LENGTH`, the guard MOVED from the retired `escalation_resolution.reply_text`).
**A client-controlled value used as a tenant-partitioned KEY is safe (inert-or-self-harm) — `seq` (Phase 34)
joins `provider_message_ref` (Phase 26) in that pattern.**
