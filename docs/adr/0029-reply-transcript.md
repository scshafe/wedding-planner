# ADR 0029 — Reply transcript in the inbox (persist the operator's answer)

- **Status:** accepted
- **Date:** 2026-06-28
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-28-phase-29-reply-transcript.md`)
- **Scope:** Phase 29 — make the escalation inbox show the **question → answer transcript**. Phase 28 let a
  couple/planner reply to an escalated guest, but it persisted only that a send *happened* (the meter), **not
  what was said** — so after replying the operator saw a bare "Resolved by couple" with no record of their own
  answer. Persist the operator's reply content on the resolution and render it on the Handled row, so the
  inbox reads as a two-line transcript: the guest's question (`escalation.text`) and the operator's reply
  (`resolution.reply_text`).
- **Builds on** the reply-from-the-inbox path ([[reply-from-inbox]], ADR 0028), the resolution record
  ([[escalation-resolution]], ADR 0027), and the conditional-spread absent-key mechanism
  ([[clear-to-absent-logistics-sentinel]], ADR 0025). Reuses the one safety model — **no new safety
  machinery**; this is the deliberate resolution of Phase 28's recorded `arch3` deferral ("don't persist
  reply_text — recorded decision").

## Context

Phase 28 deliberately did **not** persist the reply text (its architect review recorded the deferral). The
gap it left is real and product-visible: an operator who answers a guest sees no record of their own answer,
so the inbox is not yet a usable conversation surface. Persisting the reply closes that gap and makes the
inbox a demoable transcript — the natural, well-scoped follow-up.

Two adversarial reviews ran on the DESIGN (via `general-purpose` agents carrying the persona lens — the named
specialists are not provisioned here): **doddy** (security/oracle) and **rigorous-architect** both
**APPROVE-WITH-FIXES**, **no constructible exploit found**. All fixes folded in before/while building. 867
tests green (was 858; +5 log/schema, +2 reply-API, +2 web).

## Decisions

### 1. `escalation_resolution` is the right home for `reply_text` (not a new schema / transcript log)

The resolution record already IS the "this escalation was handled" fact — keyed by `escalation_id`,
first-writer-wins, written in the same commit as the auto-resolve. The reply that resolved it is literally the
content of that handled fact, so `reply_text` lives there as an **OPTIONAL** property. A separate transcript
log would add the 21st schema for no new invariant, need its own tenant-scoped repo + scope filter + join, and
introduce a two-write consistency question (resolution written but transcript not) that the single-record
design eliminates by construction. One record, one write, one existing join in `renderEscalations`. It is a
MODIFY of the 20th schema — **manifest stays 20**, no new file.

The architect's recorded nuance: this couples *reply content* to the *resolution lifecycle*. When multi-turn
arrives (the deferral below), reply content must move onto a proper per-escalation message log and
`escalation_resolution.reply_text` becomes the legacy "first reply" field. That migration is cheap and
named here so a future rung doesn't treat this field as the permanent transcript home.

### 2. `reply_text` is present ONLY on the reply path — and the schema enforces "reply ⇒ resolved"

The field is populated only when the escalation is resolved by a console reply; the Phase-27 resolve-form and
dismiss paths omit it. To make that a **structural contract invariant** rather than handler discipline, the
schema carries an `allOf` `if/then` forbidding `reply_text` when `status === 'dismissed'` (a nonsensical
"dismissed-but-also-replied" record fails `assertValid`). This is the contracts-as-source-of-truth conviction
applied: the invariant is pinned in the JSON Schema, not hoped in the call sites.

### 3. The conditional spread is the SOLE absent-key mechanism

`escalation_resolution` is `additionalProperties: false` and `resolve()` runs `assertValid`, so a literal
`reply_text: undefined` would serialize the key and Ajv would reject it. The record is built with the Phase-25
pattern `...(input.reply_text === undefined ? {} : { reply_text: input.reply_text })` — the one canonical
absent-key mechanism, the only place the key enters the literal. `RecordResolutionInput` adds `reply_text?:
string` (optional, never assigned `undefined`), so resolve-form/dismiss callers that omit it produce no key.
The test asserts the key is **absent** (`'reply_text' in record === false`), not merely falsy.

### 4. No new disclosure oracle; the read surface is the scoped GET body AND the HTML render

`reply_text` is **trusted** couple/planner input, written and read back by the **same scope** that wrote it —
couple → `listForWedding` (their wedding only), planner → `list` (their tenant). doddy's F1 correction: the
read path is **both** the Bearer-authenticated `GET /t/:slug/escalations` JSON body **and** the HTML render —
the escaping argument protects only the HTML consumer, so the safety story is "read only by the scope that
wrote it," documented as such in the schema. It is **never reflected to the guest**: the guest send used the
operator's freshly-typed text at reply time; the persisted copy is read only by the inbox. On the HTML side it
is interpolated as **plain text content** through the `html` SafeHtml template (escaped exactly like
`escalation.text`, never an attribute/`href`/`src`), pinned by an XSS round-trip test. The miss path is
untouched — `RESP_REPLY_MISS` stays byte-identical; only the SUCCESS record is enriched, so persisting adds no
probe surface.

### 5. No 500 oracle on persist — the cap is drift-guarded

The "a reply that passed the handler can never fail `resolve()`'s `assertValid`" argument holds only while the
handler's `REPLY_TEXT_MAX_LENGTH` (2000) equals the schema's `reply_text` `maxLength` (2000) and
`requireString`'s non-empty guarantee matches `minLength:1`. Those are two separately-edited copies of `2000`,
so `REPLY_TEXT_MAX_LENGTH` is now **exported** and a test pins it **equal** to the schema `maxLength` (read via
the file), plus a behavioral boundary test (a 2000-char reply passes both the handler and `resolve()`). This
mirrors Phase 28's `channel.test.ts` drift guard — the byte-identity is structural, not test-hoped. The
UTF-16-vs-codepoint asymmetry is **safe in the right direction**: Ajv counts Unicode code points (≤ the JS
UTF-16 `.length` the handler checks), so the handler is always the stricter gate — astral-plane input can't
500.

### 6. Single-reply by construction; multi-turn deferred

The reply path is gated on NO prior resolution existing, so there is exactly one reply per escalation and
first-writer-wins makes the persisted `reply_text` stable (a gated-out re-reply never overwrites it). A true
multi-turn back-and-forth (follow-up replies after the first) would require decoupling reply from auto-resolve
— a larger change to the billing/resolution semantics — and is recorded as a deferral. The singular optional
field is an accurate model of the current capability, not a shape that obstructs the later message log.

## Consequences

- The inbox is now a usable conversation surface: the Handled row shows the guest's question and the
  operator's answer. The browser e2e asserts the reply renders after replying.
- `escalation_resolution` gains an optional `reply_text` (schema MODIFY, manifest stays 20). The
  "reply ⇒ resolved" invariant is contract-enforced.
- `REPLY_TEXT_MAX_LENGTH` is exported and drift-guarded against the schema cap.
- **Deferred:** multi-turn threading (follow-up replies after the first) → a per-escalation message log,
  decoupling reply from auto-resolve, at which point `reply_text` becomes the legacy first-reply field.

## Alternatives considered

- **A separate transcript / message log (21st schema).** Rejected for one rung: adds a schema + repo + join +
  two-write consistency question for no new invariant the resolution record doesn't already carry. Revisit
  when multi-turn lands.
- **Persist `reply_text` on every resolution (handler discipline only).** Rejected: the schema `allOf` makes
  "reply ⇒ resolved" structural, which the repo prefers over hoping the call sites stay correct.
- **Hard-code the 2000 cap in both places without a guard.** Rejected: two hand-edited constants silently
  drift and re-open the 500 oracle the byte-identity argument closes.
