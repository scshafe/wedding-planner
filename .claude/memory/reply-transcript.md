# Reply transcript in the inbox (Phase 29)

**What:** the escalation inbox now shows the **question → answer transcript**. Phase 28 ([[reply-from-inbox]])
let a couple/planner reply to an escalated guest but persisted only that a send *happened* (the meter), not
its content. Phase 29 persists the operator's reply and renders it on the Handled row — the deliberate
resolution of Phase 28's recorded `arch3` deferral ("don't persist reply_text"). ADR 0029. 867 tests.

## The load-bearing decisions (carry forward)

- **`reply_text` lives on `escalation_resolution`, OPTIONAL — NOT a new schema/transcript log.** The
  resolution IS the "handled" fact (keyed by `escalation_id`, first-writer-wins, written in the same commit as
  the auto-resolve); the reply that resolved it is that record's content. One record, one write, one existing
  join in `renderEscalations`. A separate log would add the 21st schema + a repo + a two-write consistency
  question for no new invariant. MODIFY of the 20th schema → **manifest stays 20**.
- **"reply ⇒ resolved" is CONTRACT-ENFORCED, not handler-hoped.** The schema carries an `allOf if/then`
  forbidding `reply_text` when `status === 'dismissed'` — a dismissed-with-reply record fails `assertValid`.
  Present only on the reply path; resolve-form/dismiss omit it.
- **The conditional spread is the SOLE absent-key mechanism** (the [[clear-to-absent-logistics-sentinel]]
  pattern): `...(input.reply_text === undefined ? {} : { reply_text: input.reply_text })`. With
  `additionalProperties:false` + `assertValid`, a literal `reply_text: undefined` would serialize the key and
  Ajv would reject it. `RecordResolutionInput.reply_text?` is optional, never assigned `undefined`. The
  "without reply" test asserts the key is **absent** (`'reply_text' in record === false`), not falsy.
- **No new disclosure oracle.** `reply_text` is TRUSTED couple/planner input, read back ONLY by the same scope
  that wrote it (couple→`listForWedding`, planner→`list`). doddy F1: the read surface is **both** the
  Bearer-authed `GET /t/:slug/escalations` JSON body AND the HTML render — so the safety story is "same scope
  reads it," NOT "it's escaped" (escaping protects only the HTML consumer). **Never reflected to the guest**
  (the send used the freshly-typed text; the persisted copy is inbox-only). The miss path
  (`RESP_REPLY_MISS`) is untouched/byte-identical — only the SUCCESS record is enriched.
- **HTML render is plain TEXT content** through the `html` SafeHtml template (escaped like `escalation.text`,
  never an attribute/`href`/`src`); XSS round-trip test pins it.
- **No 500 oracle on persist, DRIFT-GUARDED.** Schema `maxLength:2000` MATCHES the handler's
  `REPLY_TEXT_MAX_LENGTH` and `minLength:1` matches `requireString`'s non-empty guarantee, so a reply that
  passed the handler can't fail `resolve()`'s `assertValid`. The two `2000`s are separately edited →
  `REPLY_TEXT_MAX_LENGTH` is **exported** and a test pins it equal to the schema cap + a 2000-char boundary
  test (mirrors Phase 28's `channel.test.ts` drift guard). UTF-16-vs-codepoint is safe in the right direction
  (Ajv code points ≤ JS `.length`, so the handler is the stricter gate).
- **Single-reply by construction** (reply gated on no prior resolution + first-writer-wins) → the singular
  optional field is an accurate model, not a wrong shape.

## Deferred
Multi-turn threading (follow-up replies after the first) → a per-escalation **message log**, decoupling reply
from auto-resolve; at that point `escalation_resolution.reply_text` becomes the legacy "first reply" field
(a cheap migration, named in ADR 0029 so a future rung doesn't treat this field as the permanent home).
