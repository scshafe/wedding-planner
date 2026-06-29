# Phase 34 — Multi-turn console reply thread

**Branch:** `build/phase-34-multi-turn-reply-thread` (off `build/phase-33-account-home-overview`).
**Goal:** make the guest-escalation inbox a real conversation surface. Today a console reply sends ONE
metered message and AUTO-resolves the escalation (Phase 28), so an operator gets exactly one shot per
question. This phase **decouples reply from resolve**: an operator can send **multiple follow-up replies**
on an OPEN escalation (a per-escalation **thread**), and resolving/dismissing stays the explicit Phase-27
action. The thread is the question→answer transcript the inbox shows.

This is the most-cited open thread in the Phase-33 handoff and the next rung of the guest-messaging
roadmap goal ([[guest-messaging-channel-is-a-roadmap-goal]]).

## Scope (and the deliberate deferral)

IN: the **console (operator) side** of multi-turn — planner/couple send N replies on one escalation, each
metered, each double-submit-safe; the inbox renders the thread.

OUT (deferred, recorded): **guest-reply → thread correlation** (a guest texts back and it lands in the
thread). The provider-agnostic port carries only opaque refs and no conversation id, so inbound
correlation is a separate design problem (a guest texts in with only a `from_ref`, no escalation/thread
id). The inbound webhook keeps its current behavior (a fresh question → a fresh escalation). We note this
explicitly in the ADR and handoff.

## The two genuine design problems and how we resolve them

### A. The double-submit / single-charge story (the load-bearing safety change)

Phase 28's single-charge guard is **two-layered**: the PRIMARY guard is "a resolution already exists →
`RESP_REPLY_MISS`, no send"; the meter key `reply:${escalation_id}` is defense-in-depth. Decoupling
removes the auto-resolve, so the resolution-existence guard no longer stops a second reply — it *must not*
(multi-turn is the point). We need a NEW per-message double-submit guard.

**Resolution — a render-time `seq` (thread position), client-carried, put-if-absent:**
- The reply form for an escalation that currently has **N** replies carries a hidden `seq = N`
  (`= repliesFor(escalation_id).length` — a projection of the SAME scoped read that renders the page, so
  the web layer needs no new dependency / no id source; only-data-path-is-`api.handle` is preserved).
- The `EscalationReplyLog` is a `TenantScopedRepository` **keyed by `${escalation_id}:${seq}`** (composite
  `idOf`). `append` is **read-first-put-if-absent** on that key.
- The send's `idempotency_key` is the deterministic `reply:${escalation_id}:${seq}` (extends Phase 28's
  pattern; the per-tenant meter is the defense-in-depth layer).
- **Double-submit** (browser re-POST / double-click of the *same* rendered form) re-sends `seq=N` →
  the put-if-absent read finds the existing record → return early, **no second send, no duplicate thread
  row**. A genuine follow-up renders a fresh form with `seq=N+1` → a new key → a new send.
- The handler is **synchronous** (`service.send` is sync; the handler returns `ApiResponse`, not a
  Promise), so read→send→put is ONE synchronous critical section — no interleaving race (same argument as
  Phase 31's settle).
- **The read-first GATES THE SEND** (doddy P1): a re-submit at a taken slot returns BEFORE any
  `service.send`, so a double-submit is a pure zero-service no-op (the per-tenant meter dedup stays
  *defense-in-depth*, never the primary guard — matching Phase-28's philosophy). Pinned order:
  scope → absent/foreign-wedding miss → resolved/dismissed miss → **seq read-first** → send → append.
- **`seq` is REQUIRED and validated to a non-negative integer as a single masked `PRODUCT.BAD_REQUEST`
  BEFORE the escalation lookup** (doddy P1) — fires independent of existence (no oracle), exactly like the
  Phase-27 inline `status` enum check. A missing / non-integer / negative / non-numeric / `NaN` seq is the
  SAME masked 400. **Never default a missing seq to 0** (a defaulted seq is a dedup-collision/bypass
  vector). The wire carries seq as a string from the form (`"3"`) and as a number from a JSON client; the
  parse accepts both and rejects everything else uniformly. A test asserts a malformed seq on a
  *nonexistent* escalation 400s byte-identically to one on an existing escalation (existence-independence).
- **Same-seq / DIFFERENT-body ⇒ `409 conflict`, not a silent success** (doddy P1, the integrity fix). The
  read-first finds the slot taken: if the stored `body` EQUALS the submitted text → it's a true
  double-submit → idempotent `{replied:true}`, no second send. If the stored `body` DIFFERS → it's a
  lost-update (a stale form / a co-operator raced the slot) → return `409` (retry with a fresh form),
  NEVER a `{replied:true}` lie. The 409 is reachable ONLY after the full scope+open gates pass (the
  operator already sees this escalation + thread), so it discloses nothing new — no oracle. For the WEB
  flow the 409 is swallowed by the PRG redirect; the operator lands back on the inbox, sees their message
  absent, and the now-`seq=N+1` form lets them resend. This closes the "silent suppression reported as
  success" gap WITHOUT a nonce store.

**Why a client-carried `seq` is safe (doddy lens):** `seq` is the ONLY value that matters from the body
besides the body text; channel/recipient/wedding_id all still come from the LIVE escalation. A forged
`seq`:
- already-used → put-if-absent finds the existing record → no send, inert (self-dedup);
- far-future (e.g. 999) → occupies key `esc:999`; thread DISPLAY orders by `seq`, so a gap is harmless;
  the next legit form computes `seq = thread.length` and is unaffected. The operator merely sent a
  message — their own metered, charged capability. No cross-tenant reach (the meter + log are
  `context.tenant_id`-partitioned), so the only thing a forged seq can do is **self-harm / no-op**.
- Suppression: a replayed `seq` dedups only the operator's OWN tenant's meter (Phase-18 per-tenant
  idempotency) — suppressing your own charge is self-harm, never another tenant's.

**The concurrent-distinct-operator collision is now HONEST, not silent.** Two operators both at `seq=N`
submitting *different* bodies: the first wins + sends; the second gets a `409` (same-seq/different-body,
above) and resends from a fresh `seq=N+1` form. No silent lost-update. We still do NOT add a nonce store
(it would add an id source to the web layer for a corner case the 409 already makes honest + retryable).
**Rejected alternative — content-hash key** (`${escalation_id}:${hash(body)}`): it would let two distinct
bodies coexist but would SILENTLY dedup a legitimate *identical* repeat answer ("Yes, parking is free"
twice) — a more common console action than the distinct-operator race — and loses the natural monotonic
thread order. Recorded in the ADR.

### B. Decoupling reply from resolve (the model change)

- A reply **appends to the thread + sends**; it no longer records a resolution. The escalation stays
  **OPEN** until an explicit resolve/dismiss (Phase 27, unchanged).
- The Phase-28 **"already handled (resolved OR dismissed) → no send"** gate STAYS — it now means
  *"a closed escalation accepts no further replies"*, which preserves the doddy F1/F2 property that a
  **dismissed escalation can never dispatch a billed guest message**. Within OPEN, multiple replies are
  allowed (each `seq`-keyed); once resolved/dismissed, replies stop. (So the dismissed-no-bill property is
  unchanged; the double-submit property moves from "resolution exists" to the `seq` key.)
- **`reply_text` on the resolution (Phase 29) is RETIRED.** With decoupling the reply path no longer
  writes a resolution, so the resolution's optional `reply_text` would be dead surface. The **thread
  (`escalation_reply.body`) now owns the transcript.** We REMOVE `reply_text` (and its `allOf`
  dismissed-forbidden rule) from `escalation_resolution`, re-gen its type, and move the render of the
  question→answer transcript to the thread. The Phase-29 security argument (trusted operator input, HTML-
  escaped at render, never reflected to the guest, length-capped + drift-guarded) transfers verbatim to
  `escalation_reply.body` — same guarantees, new home. (No data migration: stores are in-memory and reset
  per process.)

## The new contract — `escalation_reply` (21st schema)

`product/schemas/escalation_reply_schema.json`, `additionalProperties: false`, all required:
- `reply_id` — string minLength 1 (platform-minted surrogate `ids.next('reply')`; NOT the storage key).
- `tenant_id` — string minLength 1 (compare-only in the repo; the context selects the partition).
- `escalation_id` — string minLength 1 (the thread filter key — couple/planner read replies by joining on
  it; the escalation's public id, copied from the live escalation in the same request).
- `wedding_id` — string minLength 1 (couple-scope filter, COPIED from the live escalation, never the body).
- `seq` — integer, minimum 0 (the thread position = idempotency/order key; the composite storage key is
  `${escalation_id}:${seq}`). **PROVENANCE NOTE (architect P1):** this is the ONE persisted field whose
  value originates in the request body — it is a *client/external-controlled KEY*, safe for the same reason
  `escalation_log`'s `provider_message_ref` is safe as a key: the partition is `context.tenant_id` ALONE,
  so a forged seq is inert-or-self-harm within the caller's own tenant (never cross-tenant/cross-wedding
  reach). The schema doc + the log doc-comment both name that precedent.
- `sender` — enum `[planner, couple]` (the role of the principal who sent it — `principal.role`, never the
  body; display metadata, never read for a decision).
- `body` — string minLength 1, maxLength 2000 (the operator's reply text; TRUSTED operator input, HTML-
  escaped at render, **never reflected to the guest — the guest send used the operator's freshly-typed
  text; this persisted copy is the transcript, read only by the same scope that wrote it** (the Phase-29
  provenance note, moved here verbatim). maxLength matches the handler's cap (`REPLY_BODY_MAX_LENGTH`) so a
  reply that passes the handler can never fail `assertValid` here — no 500 oracle; the two `2000`s are
  drift-guarded by a test that is MOVED (not deleted) from `escalation_resolution.reply_text`.
- `sent_at` — string minLength 1, no format/pattern (ISO-8601 from the injected clock; minLength:1 so the
  real `clock.now()` can never fail validation — matches `resolved_at`/`received_at`).

Manifest 20→21: add the key to the `ContractKey` union + a `CONTRACT_DEFINITIONS` entry in
`shared/src/contracts/contract_manifest.ts`; run `npm run gen:types`; bump the count test (20→21) + its
title prose in `shared/tests/contracts/schema_registry.test.ts`; bump the gen-script header count if it
carries one.

---

## Steps

### Step 0 — design review (APPROVE-WITH-FIXES gate)
Run two adversarial general-purpose agents carrying the **doddy** (security/trust-boundary) and
**rigorous-architect** (design) personas (the named sub-agents aren't provisioned here — handoff rail).
Feed them this plan. Focus doddy on: (1) the client-carried `seq` as an idempotency key — any cross-tenant
or suppression abuse beyond self-harm? (2) the dismissed-no-bill property under decoupling; (3) retiring
`resolution.reply_text` — does the transcript's security argument transfer cleanly? (4) any new existence
oracle from the 3-array read or the `seq` 400. Focus the architect on: the seq-as-key design vs a nonce
store, the decoupled state model, whether `escalation_reply` should carry `seq` as a field, and the
known concurrent-distinct-operator collision. Fold findings into this plan, then commit the plan +
"design review" note. **Tick when both APPROVE (with fixes folded).**

**OUTCOME — both APPROVE-WITH-FIXES (no exploit; design sound). All fixes folded above:**
- doddy P1 ×6: send gated by the read-first (zero-service double-submit); resolved/dismissed gate stays
  ahead of the send + tested (dismissed-no-bill); `seq` a single masked 400 before the lookup, never
  defaulted; `escalation_reply` carries `wedding_id` + `listForWedding` filters + couple-can't-read-sibling
  test + index built from the scoped array; `body.maxLength` drift-guard moved + every `reply_text` reader
  migrated; **same-seq/different-body ⇒ `409`** (the silent-success → honest-signal fix, no nonce store).
- architect P1 ×5: `seq` provenance documented as a client-controlled KEY (the `provider_message_ref`
  precedent); **numeric** seq sort; drift-guard test MOVED not deleted; **wire field stays `reply_text`**
  (discriminator unchanged) while the schema field is `body`/constant `REPLY_BODY_MAX_LENGTH`;
  existence-independence test for the `seq` 400.
- architect P2 ×3: `countOpenEscalations` stays reply-agnostic (noted); absent-`seq` → required 400
  documented; content-hash-key alternative recorded as rejected (it would silently dedup a legit identical
  repeat answer — a more common case than the race it fixes) → ADR.
- doddy P2 ×2: pre-seeded-seq suppression (within the shared trust zone; the 409 closes the *silent* part)
  → ADR; `body` guest-non-reflection provenance in the schema doc + numeric sort never array-indexes seq.

### Step 1 — `escalation_reply` schema + retire `resolution.reply_text`
- Add `product/schemas/escalation_reply_schema.json` (above).
- Remove `reply_text` (property + the `allOf`) from `escalation_resolution_schema.json`.
- `contract_manifest.ts`: add `escalation_reply` to the union + `CONTRACT_DEFINITIONS` (after
  `escalation_resolution`).
- `npm run gen:types` → generates `escalation_reply.ts`, regenerates `escalation_resolution.ts` (no
  `reply_text`); export `EscalationReply` from `contract_types.ts`.
- `schema_registry.test.ts`: 20→21 + title prose; gen-script header count if present.
- Build + the contracts tests green. Commit.

### Step 2 — `EscalationReplyLog` + decoupled reply handler + read
- New `product/src/messaging/escalation_reply_log.ts`: `TenantScopedRepository<EscalationReply>` keyed by
  `${escalation_id}:${seq}` (composite `idOf`). The handler does the **read-first itself** (`readSlot(ctx,
  escalation_id, seq)` → `EscalationReply | undefined`) so it can branch true-double-submit vs
  409-conflict vs append; `append(context, input)` stamps `reply_id`/`sent_at` from injected ids/clock and
  `assertValid`s before `put`. `listForEscalation(ctx, escalation_id)` filters the partition by
  escalation_id and **sorts NUMERICALLY by `seq` (`a.seq - b.seq`, never lexicographic** — architect P1, or
  `10` sorts before `2`) for the render join; `list`/`listForWedding` (planner/couple scope, mirrors the
  resolution log, `undefined → []`) for the scoped read. Mirror the escalation_resolution_log doc style and
  the `provider_message_ref`-as-key provenance precedent for `seq`.
- `product_api.ts`:
  - `EscalationHandlerDeps` gains `replies: EscalationReplyLog`.
  - **WIRE-FIELD PIN (architect P1):** the request/discriminator field stays named `reply_text` (so
    `dispatchEscalations`' `body.reply_text !== undefined` discriminator is UNCHANGED). Only the *schema*
    field is `body` and only the exported constant is renamed `REPLY_BODY_MAX_LENGTH`. A one-line comment
    warns against "consistency-renaming" the wire field to `body` (would silently break the discriminator).
  - `handleEscalationReply` rewrite, PINNED order: (1) scope; (2) read `escalation_id`, `reply_text`
    (required, non-empty, length ≤ `REPLY_BODY_MAX_LENGTH`), `seq` (required → non-negative integer; all of
    these are masked 400s BEFORE the lookup, existence-independent, no oracle); (3) `getByEscalationId` →
    absent / couple-foreign-wedding → `RESP_REPLY_MISS`; (4) **resolved/dismissed** (a resolution exists)
    → `RESP_REPLY_MISS` — closed escalation, no billed send (the dismissed-no-bill keystone STAYS; it no
    longer doubles as the double-submit guard but it is NOT dead); (5) **read-first slot
    `${escalation_id}:${seq}`**: exists+same body → idempotent `{replied:true}` (no send); exists+different
    body → `409` (no send); (6) else `service.send(... idempotency_key: reply:${escalation_id}:${seq})`
    (commit-after-success; structured failure → `RESP_REPLY_MISS`, escalation stays Open + retryable),
    then `replies.append(...)` (sender = `principal.role`, wedding_id + escalation_id from the LIVE
    escalation, never the body). → `{replied:true}`. **No resolution write.**
  - `handleEscalationList` returns `{escalations, resolutions, replies}` — all three scoped by the SAME
    `manageScope` branch (planner whole-tenant `list`, couple `listForWedding`). The render index is built
    from this already-scoped `replies` array, NEVER a request-supplied escalation_id (no bypass of the
    wedding filter).
  - Re-point the exported constant `REPLY_TEXT_MAX_LENGTH` → `REPLY_BODY_MAX_LENGTH` + MOVE its drift-guard
    test to `escalation_reply.body.maxLength` (name the specific test).
- `compose.ts`: construct `new EscalationReplyLog(tenants, ids, clock)` and wire into the escalations deps.
- Tests: a new `escalation_reply_log` unit test (seq read-first/put idempotency, numeric sort, scope
  filter, cross-tenant veto inherited, couple cannot read a sibling wedding's thread). JSON
  `product_api`/messaging reply e2e: reply no longer resolves (escalation stays Open); a second DISTINCT
  reply at seq=1 sends again; a true double-submit at the same seq+same body sends once (`{replied:true}`);
  a same-seq+DIFFERENT-body → `409`; a dismissed escalation still refuses a billed reply; a malformed/absent
  `seq` 400s identically on a nonexistent vs existing escalation (existence-independence); the 3-array read.
  Build + test + lint green. Commit.

### Step 3 — inbox thread render + reply-form `seq` + web wiring
- `pages.ts` `renderEscalations`: take a `replies` array; build a `repliesIndex` (Map escalation_id →
  sorted replies). OPEN rows render the thread (each reply: sender + body, escaped via `html`) + a reply
  form whose hidden `seq = repliesFor(id).length`. HANDLED rows render the full thread as the transcript
  (replacing the Phase-29 `r.reply_text` line). Update the page doc + the intro copy ("reply as many times
  as you need; mark resolved when you're done"). **`countOpenEscalations` stays reply-agnostic** (architect
  P2): open = no resolution; a replied-but-unresolved escalation still counts as needs-attention — add a
  one-line note so a future reader doesn't "fix" it to subtract replies.
- `product_web_ui.ts`: add `readReplies(body)`; pass the replies array to `renderEscalations`; the reply
  FORM post forwards `seq` (`form.get('seq')`) in the JSON body alongside `escalation_id`/`reply_text`.
- Migrate the web e2e (`billing_web`/escalation web tests + the Phase 29 transcript test) to the thread
  model. Build + test + lint green. Commit.

### Step 4 — ADR 0034 + memory + handoff
- ADR `docs/adr/0034-multi-turn-reply-thread.md`: the decoupling, the seq-keyed double-submit story, the
  retired `resolution.reply_text`, the deferred guest-inbound correlation, the documented
  concurrent-distinct collision.
- Memory `.claude/memory/multi-turn-reply-thread.md` + an index line in `MEMORY.md`; link
  [[reply-from-inbox]], [[reply-transcript]], [[guest-escalation-inbox]].
- Update `.claude/handoff.local.md` (where we are, next lever, fresh context).
- Final `npm run build && npm test && npm run lint` green. Commit.

## Verification gate (every step)
`npm run build && npm test && npm run lint` all green before ticking a box or committing. Run build/lint
standalone (never piped — `${PIPESTATUS[0]}` lesson). `npm run build` from repo root. Schema change ⇒
`npm run gen:types`.

## Safety rails (unchanged)
Offline-first (no real money/comms; a real provider sending real texts stays the human crossing). One
safety model. Don't touch `ops/` or `CLAUDE.md`. Push only to `origin`. Adversarial reviews via
general-purpose agents carrying the persona lens. Schema add ⇒ gen:types + manifest count bump.
