# Phase 29 — Reply transcript in the inbox (persist the operator's answer)

## Goal
Make the escalation inbox show the **question → answer thread**. Phase 28 let a couple/planner reply to an
escalated guest, but it persists only that a send *happened* (the meter), **not what was said** — so after
replying the operator sees a bare "Resolved by couple" with no record of their own answer. Persist the
operator's reply content alongside the resolution and surface it on the Handled row, so the inbox reads as a
two-line transcript: the guest's question (`escalation.text`) and the operator's reply. This is the
deliberate resolution of Phase 28's recorded `arch3` deferral ("don't persist reply_text — recorded
decision"); it naturally extends [[reply-from-inbox]].

## The crux (carry forward)
- **`reply_text` lives on the `escalation_resolution` record, OPTIONAL.** The resolution is already the
  "this escalation was handled" fact keyed by `escalation_id`, first-writer-wins; the reply that resolved it
  is that record's content. Present ONLY on the reply path; **absent on the resolve-form and dismiss paths**
  (those resolve with no reply). MODIFY of the 20th schema — manifest count stays 20, no new schema file.
- **Conditional-spread is mandatory, not cosmetic.** The repo's `additionalProperties:false` + Ajv reject a
  literal `reply_text: undefined`, so `resolve()` must build the field with the Phase-25 pattern
  `...(input.reply_text === undefined ? {} : { reply_text: input.reply_text })` — the ONE absent-key
  mechanism — never assign `undefined`.
- **No new disclosure, no new oracle.** `reply_text` is TRUSTED operator input (an authenticated
  couple/planner), read back ONLY by the SAME scope that wrote it (couple → their wedding, planner → tenant),
  HTML-escaped at render via the `html` SafeHtml template (like `escalation.text`), and **never reflected to
  the guest**. The miss path is untouched — `RESP_REPLY_MISS` is byte-identical; we only enrich the SUCCESS
  record. So persisting it adds no probe surface a couple could exploit.
- **No 500 oracle on persist.** The schema `maxLength` MATCHES the handler's `REPLY_TEXT_MAX_LENGTH` (2000)
  and `minLength:1` matches `requireString`'s non-empty guarantee, so a `reply_text` that passed the handler
  can never fail `resolve()`'s `assertValid` — mirroring the Phase-26 `guest_escalation.text` byte-identity
  argument (the capture is not swallowed/500'd).
- **Single-reply, by construction.** The reply path is gated on NO prior resolution, so there is exactly one
  reply per escalation and first-writer-wins makes the persisted `reply_text` stable. A true multi-turn
  back-and-forth (follow-up replies after the first) would require decoupling reply from auto-resolve — out
  of scope, recorded as a deferral.

## Steps

- [x] **Step 0 — Adversarial design review (doddy + architect lens via `general-purpose` agents).**
  BOTH APPROVE-WITH-FIXES, no exploit found. Folding in:
  - **(doddy F1) The read surface is the JSON `GET /t/:slug/escalations` body, not only the HTML render.**
    The escaping argument protects the HTML consumer only; the safety story is "read by the SAME scope that
    wrote it" (couple→`listForWedding`, planner→`list`) — state the read path in ADR/memory/schema desc as
    "returned in the scoped GET JSON body AND HTML-escaped when rendered," so a future JSON consumer doesn't
    trust an escaping that isn't theirs.
  - **(doddy F2) Render `reply_text` as TEXT content only** — a direct `${r.reply_text}` hole in an
    `html`-tagged literal (matching `e.text` at pages.ts:310), never an attribute/`href`/`src`, never a
    pre-built string. Pin with an XSS round-trip test.
  - **(doddy F4 / 5a) The conditional spread is the SOLE mechanism;** the "without reply_text" test asserts
    the key is **absent** (`'reply_text' in record === false`), not merely falsy.
  - **(architect 4a — ADOPT) Make "reply ⇒ resolved" STRUCTURAL in the schema:** add `allOf: [{ if:
    {properties:{status:{const:'dismissed'}}}, then: {not:{required:['reply_text']}} }]` so a
    `{status:'dismissed', reply_text}` record fails `assertValid`. Contract-enforced, not handler-hoped.
  - **(architect 4b / 5b — ADOPT) Cap-drift guard:** `REPLY_TEXT_MAX_LENGTH` (handler) and the schema
    `maxLength` are two hand-edited `2000`s; add a test asserting they're equal (read the schema maxLength via
    the registry) + a boundary test (a 2000-char reply passes BOTH the handler and `resolve()`'s assertValid →
    no 500). Mirrors Phase 28's `channel.test.ts` drift guard.
  - **(architect 1 / 4c — RECORD in ADR) Nuances:** (a) `escalation_resolution` is the right home (one
    record, one write, one existing join — a separate transcript log would add the 21st schema + a two-write
    consistency question for no new invariant), but multi-turn will later migrate reply content onto a message
    log, making this field the legacy "first reply"; (b) the UTF-16-vs-codepoint asymmetry is SAFE in the
    right direction (Ajv counts code points ≤ JS UTF-16 length, so the handler is always the stricter gate).

- [x] **Step 1 — Schema + log: persist `reply_text`.** Done; 863 tests green (+5).
  - Add optional `reply_text` to `product/schemas/escalation_resolution_schema.json`: `{ "type": "string",
    "minLength": 1, "maxLength": 2000, "description": "..." }`. NOT in `required`. PLUS the `allOf if/then`
    (architect 4a) forbidding `reply_text` when `status === 'dismissed'`. Description (doddy F1): present only
    when the escalation was resolved by a console reply (Phase 29); the operator's trusted answer text,
    returned in the scoped `GET /t/:slug/escalations` JSON body AND HTML-escaped when rendered, never
    reflected to the guest; maxLength matches the handler's `REPLY_TEXT_MAX_LENGTH` so a persisted reply can't
    fail validation. `npm run gen:types` (regenerates `escalation_resolution.ts`). Manifest stays 20.
  - `RecordResolutionInput` gains `readonly reply_text?: string`.
  - `EscalationResolutionLog.resolve`: build the record with the conditional spread for `reply_text`
    (`...(input.reply_text === undefined ? {} : { reply_text: input.reply_text })` — the SOLE place the key
    appears); `assertValid` already runs. Update the canonical doc comment to note the optional reply content.
  - `escalation_resolution_log.test.ts`: a resolve WITH reply_text persists+reads it; a resolve WITHOUT it
    asserts the key ABSENT (`'reply_text' in record === false`); first-writer-wins keeps the first reply_text
    on re-resolve; a `{status:'dismissed', reply_text}` input FAILS `assertValid` (4a); the cap-drift guard +
    2000-char boundary byte-identity test (4b).
  - Verify: `npm run build && npm test && npm run lint` green ($? checked, build standalone).

- [x] **Step 2 — Reply handler passes the text through; render the thread.** Done; 867 tests green (+4).
  - `handleEscalationReply` (`product_api.ts`): pass `reply_text` into `resolutions.resolve({...})`. The
    resolve-form handler and dismiss leave it absent (unchanged).
  - `pages.ts` `renderEscalations`: on the Handled row, if `r.reply_text !== undefined`, render it as the
    answer line beneath the guest's question (via `html` — escaped), e.g. a `note` "Replied: “…”". The badge
    stays. Open rows unchanged.
  - Tests: `escalation_reply_api.test.ts` — the recorded resolution carries the sent `reply_text` (read back
    via the escalations GET); a resolve-form resolution has none. `pages.test.ts` — a handled-by-reply row
    shows the reply text (and an XSS reply payload is escaped); a resolve-form handled row shows no reply line.
  - Verify green.

- [x] **Step 3 — ADR 0029 + memory + handoff.** Done. ADR 0029 written; memory [[reply-transcript]] + indexed;
  handoff updated. Phase 29 COMPLETE. Write `docs/adr/0029-*.md`; add
  `.claude/memory/reply-transcript.md` (link [[reply-from-inbox]], [[clear-to-absent-logistics-sentinel]] for
  the conditional-spread pattern) + index it in `MEMORY.md`; update `.claude/handoff.local.md`. Commit per
  step. Record the multi-turn-thread deferral.

## Safety rails (unchanged)
Offline-first (no real money/booking/comms). One safety model. Don't touch `ops/` or `CLAUDE.md`. Push only
to origin. The disclosure floor (Phase 14) and no-oracle keystone (Phase 27/28) are preserved — `reply_text`
is read only by the scope that wrote it and never reaches the guest. Schema MODIFY ⇒ `npm run gen:types`;
manifest stays 20 (no new file).
