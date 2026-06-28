# Handoff

## Where things stand — Phase 29 (reply transcript in the inbox) is COMPLETE ✅
`.claude/plans/2026-06-28-phase-29-reply-transcript.md` is **complete — Step 0 design review + Steps 1–3
ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3–29
build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**867 tests**, up from 858 at the start of this run).

This rung makes the Phase-26/27/28 escalation inbox a usable **conversation surface**: Phase 28 let the
couple/planner reply to an escalated guest but persisted only that a send *happened* (the meter), not its
content. Phase 29 persists the operator's `reply_text` and renders it on the Handled row, so the inbox reads as
a **question → answer transcript** (guest's `escalation.text` + operator's `resolution.reply_text`). It is the
deliberate resolution of Phase 28's recorded `arch3` deferral ("don't persist reply_text"). doddy + architect
APPROVE-WITH-FIXES on the design (no exploit); all fixes folded in. ADR 0029, memory [[reply-transcript]].

## What changed this phase
- **`escalation_resolution` schema gains an OPTIONAL `reply_text`** (string, minLength 1, maxLength 2000) PLUS
  an `allOf if/then` forbidding it when `status === 'dismissed'` (reply ⇒ resolved, CONTRACT-enforced). MODIFY
  of the 20th schema (manifest stays 20); `gen:types` emits it.
- **`escalation_resolution_log.ts`** — `RecordResolutionInput` gains `reply_text?: string`; `resolve()` builds
  it via the conditional spread (`...(input.reply_text === undefined ? {} : { reply_text: input.reply_text })`
  — the SOLE place the key enters, so resolve-form/dismiss omit it). Canonical doc comment updated.
- **`product_api.ts`** — `handleEscalationReply` passes `reply_text` into `resolutions.resolve(...)` (already
  non-empty + length-capped, so it can't fail `assertValid`). `REPLY_TEXT_MAX_LENGTH` is now **exported** (+ in
  the barrel) for the drift guard.
- **`pages.ts`** — `renderEscalations` Handled row shows a `Replied: "…"` line when `r.reply_text` is present,
  interpolated as plain TEXT through the `html` template (escaped like `e.text`, never an attribute).
- **Tests** — `escalation_resolution_log.test.ts` +5 (persist+read / key-absent-when-omitted /
  first-writer-wins keeps first reply / dismissed+reply fails assertValid / cap-drift guard + 2000-char
  boundary); `escalation_reply_api.test.ts` +2 (persisted answer round-trips via the scoped GET / resolve-form
  has no reply_text key); `pages.test.ts` +2 (transcript line shown for reply, absent for form-resolve / XSS
  reply_text escaped); `compose.test.ts` Phase-28 e2e +1 assertion (the reply renders in the browser inbox).

## The load-bearing insight (carry forward) — see [[reply-transcript]] for the full set
- **`reply_text` lives on `escalation_resolution`, not a new log** — it's the "handled" fact's content (one
  record, one write, one existing join). Manifest stays 20.
- **"reply ⇒ resolved" is contract-enforced** (schema `allOf` forbids `reply_text` on `dismissed`).
- **Conditional spread is the SOLE absent-key mechanism** (`additionalProperties:false` would reject a
  serialized `reply_text: undefined`); the test asserts the key ABSENT, not falsy.
- **No new oracle:** TRUSTED couple/planner input read back ONLY by the scope that wrote it; the read surface
  is the scoped GET JSON body AND the HTML render (so "same scope reads it" is the safety story — escaping
  protects only the HTML consumer); never reflected to the guest; rendered as plain TEXT (XSS pinned).
- **No 500 oracle, DRIFT-GUARDED:** schema maxLength == exported `REPLY_TEXT_MAX_LENGTH` (2000), pinned by a
  test + a boundary test (mirrors Phase 28's `channel.test.ts` drift guard).

## Next action — your call. Pick the next high-value lever (ranked)
- **Multi-turn reply thread** — the natural extension of THIS phase: a per-escalation **message log** so an
  operator can send follow-ups after the first reply (and a guest's reply lands in the thread), decoupling
  reply from auto-resolve. At that point `escalation_resolution.reply_text` becomes the legacy "first reply"
  field (named in ADR 0029). Medium-large; the biggest product step for the inbox.
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (per-wedding `recipient_ref`
  namespacing OR masked-conflict semantics that doesn't corrupt the planner path). The most-cited open
  product-authz deferral. Medium; needs a real design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller.
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
run did, at design — both APPROVE-WITH-FIXES, no exploit). **CI/exit-code lesson:** never pipe `npm run build`
to tail/grep when gating with `&&` (the pipe masks the non-zero exit); run build standalone, check `$?`. `npm
run build` runs from REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never
`product`** (the firewall, by reachability). **Schema change ⇒ `npm run gen:types`**; a NEW schema file
additionally bumps the manifest count test (+ title prose) + the gen-script header — Phase 29 only MODIFIED the
20th schema (added optional `reply_text`), so the manifest stays 20. **The guest responder's security boundary
is `projectGuestVisibleFacts`'s allow-list.** **Web-form mutations are CSRF-gated at the web layer ONLY** (the
JSON API is Bearer-only / not CSRF-reachable). **The web UI's ONLY data path is `api.handle()`.** **Guest/manage
scope comes from the MINTED principal, never the request body.** **A scoped mutation that must be oracle-free
returns ONE shared frozen miss constant on every miss branch** (Phase 27 `RESP_RESOLVE_MISS`, Phase 28
`RESP_REPLY_MISS`). **An optional schema field is built via the conditional spread (the SOLE absent-key
mechanism — `additionalProperties:false` rejects a serialized `undefined`); test the key's ABSENCE, not
falsiness.** **A coupled validation constant (a handler cap == a schema cap) MUST be drift-guarded by a test**
(Phase 29 `REPLY_TEXT_MAX_LENGTH` == schema maxLength; Phase 28 `channel` Exact<> guard).
