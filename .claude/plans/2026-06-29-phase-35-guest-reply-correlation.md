# Phase 35 — Guest-reply → thread correlation

**Branch:** `build/phase-35-guest-reply-correlation` (off `build/phase-34-multi-turn-reply-thread`).
**Goal:** close the multi-turn loop's deferred half. Today every inbound guest message that the platform
can't answer (`escalated`) opens a **fresh** escalation — a guest who texts a follow-up while their
question is still OPEN spawns a *second* escalation instead of continuing the conversation. This phase
makes an inbound guest follow-up **land in the guest's most-recent OPEN escalation's reply thread** (as a
`guest`-sender turn), so the inbox shows the real back-and-forth: guest asks → operator replies → guest
replies → operator replies → resolve.

This is the most-cited open lever in the Phase-34 handoff and the next rung of the guest-messaging
roadmap goal ([[guest-messaging-channel-is-a-roadmap-goal]]), building directly on
[[multi-turn-reply-thread]] (Phase 34), [[guest-escalation-inbox]] (Phase 26),
[[escalation-resolution]] (Phase 27).

## Scope (and the deliberate deferrals)

IN: the **guest (inbound) side** of multi-turn — when an inbound guest message would otherwise open a
new escalation (`escalated`), if that guest (`from_ref`) has an OPEN escalation in their CURRENTLY-BOUND
wedding, append the message to that escalation's thread as a `guest` turn instead of recording a new
escalation. The inbox renders guest turns interleaved with operator turns. No new send, no new charge —
a guest turn is a RECEIVED message we record; only operator replies meter.

OUT (deferred, recorded):
- **Threading the `answered` follow-up.** When a guest's follow-up is auto-answerable (a fact was filled
  meanwhile), we still send the metered auto-reply but do NOT thread it / do NOT auto-resolve the open
  escalation. Correlation handles ONLY the `escalated` branch (the conversational case). An operator
  resolves the open escalation manually. (Threading auto-answers would interleave a synthetic
  operator-equivalent turn for marginal value — recorded as a follow-up.)
- **A correlation time-window.** We thread into ANY open (unresolved) escalation for that guest+wedding,
  most-recent first; we do NOT also require it to be recent. "Open" (unresolved) is the gate; a stale
  unresolved conversation is still that guest's unresolved conversation. (A window adds a magic constant
  + a clock read for marginal benefit — recorded.)

## The genuine design problems and how we resolve them

### A. Correlation WITHOUT a conversation id (the core problem)

The provider-agnostic port carries only opaque refs (`from_ref`, `provider_message_ref`) and **no
conversation/thread id** — a guest texts in with a `from_ref`, nothing tying it to escalation E1. So the
target escalation must be **inferred server-side from trusted domain state**, never from the guest's
payload.

**Resolution — the (from_ref ∧ bound-wedding ∧ open ∧ most-recent) selector:**
- After the responder returns `escalated`, select the target with
  `mostRecentOpenEscalationForGuest(context, deps, binding.wedding_id, message.sender_ref)`:
  1. `deps.escalations.listForWedding(context, binding.wedding_id)` — the bound wedding's escalations
     (tenant-scoped partition filter, oracle-free);
  2. `.filter(e => e.from_ref === message.sender_ref)` — only THIS guest's escalations;
  3. `.filter(e => deps.resolutions.getByEscalationId(context, e.escalation_id) === undefined)` — only
     OPEN (no resolution = open, the same join the inbox uses);
  4. pick the max by `received_at` (ISO-8601 UTC, lexicographically comparable at fixed width; stable
     tiebreak on `escalation_id` so the selection is deterministic).
- If a target exists → thread the message into it; else → fall through to the existing
  `escalations.record(...)` (a genuinely new conversation opens a new escalation).

**Why the DUAL match (from_ref AND bound-wedding) is load-bearing — the cross-wedding mis-segmentation
defense (doddy lens).** A `recipient_ref` is the registry's tenant-GLOBAL key bound to ONE wedding at a
time, but a planner can re-bind it (remove the guest from wedding A, register the same ref to wedding B).
Old escalations carry `wedding_id = A`; the new binding says `wedding_id = B`. Selecting by `from_ref`
ALONE could land a wedding-B message into a wedding-A open thread — a cross-wedding leak. Filtering the
candidate set by `binding.wedding_id` (the CURRENT trusted binding) excludes wedding-A escalations
entirely, so a re-bound guest's message can only ever reach an open escalation in their *current* wedding.
`from_ref` AND `wedding_id` both come from TRUSTED state (the live binding + the recorded escalation),
never the inbound body.

**Why a guest can't target an arbitrary thread (doddy lens).** The guest controls ONLY `sender_ref`
(their own ref, vetoed by the registry binding — an unknown ref → uniform 202, no thread) and `body`.
They supply NO `escalation_id`/`seq`/`wedding_id`; the target is selected entirely server-side from their
own bound wedding + their own ref. So a guest can only ever append to THEIR OWN conversation — never
another guest's thread (different `from_ref`) and never another wedding (the binding pins it).

### B. The two idempotency models must NOT be conflated

An operator reply dedups by **`seq`** (a form re-POST carries the same render-time `seq` → the composite
`${escalation_id}:${seq}` slot is read-first-put-if-absent). A guest reply has **no form and no seq** — a
provider **re-delivery** carries the same **`provider_message_ref`**. Computing `seq = thread.length` and
appending would let a re-delivery (after the first append grew the thread) compute `seq+1` and append a
DUPLICATE. So a guest turn MUST dedup by `provider_message_ref`, exactly as `escalation_log.record`
already does for the escalation itself.

**B0. The PROCESS-ONCE gate — the re-delivery routing-instability bug (self-caught; BOTH review agents
missed it).** The split routing (thread-or-record) makes a per-thread ref-scan INSUFFICIENT, because the
selector's output can change between deliveries:
- *The common break:* a brand-new escalated question finds no open escalation → records a fresh escalation
  `E_new` (now OPEN) with `provider_message_ref = R`. A provider RE-DELIVERY of that SAME message (ref `R`)
  re-runs the selector, which now picks `E_new` (open, this guest, this wedding) and threads `R` as a guest
  turn — `E_new`'s thread was empty so the per-thread ref-scan doesn't catch it. **Every re-delivery of a
  freshly-escalated message would create a spurious duplicate guest turn.**
- *The cross-resolve break:* a follow-up `R2` threads into `E_new`, `E_new` is resolved, then `R2`
  re-delivers → selector finds no open escalation → records `R2` as a FRESH escalation (duplicate of the
  threaded turn).
- **Fix — gate the whole escalated branch on TWO "already processed?" reads BEFORE routing:**
  1. `escalations.getByProviderRef(context, R)` — the `EscalationLog` repo is ALREADY keyed by
     `provider_message_ref`, so this is an **O(1)** `#repo.read`. If `R` already created an escalation → the
     re-delivery is a no-op (never threaded).
  2. `replies.guestTurnByProviderRef(context, R)` — a tenant-scoped scan for a guest turn carrying `R`. If
     `R` already landed as a guest turn (in ANY escalation, even a since-resolved one) → no-op. Closes the
     cross-resolve break.
  Then route (thread vs fresh-record). This is the escalated-branch analogue of the answered branch's
  top-of-handler `receipts.seen(R)` short-circuit — each side-effect log still owns its own idempotency
  (no widening of the doddy-P0 receipt log); the gate just consults BOTH escalated-side logs before routing.
  Enumerated cases all collapse to exactly one record per inbound ref.

**Resolution — a separate `recordGuestReply` entry point on `EscalationReplyLog`:**
- `recordGuestReply(context, {escalation_id, wedding_id, provider_message_ref, body})`:
  1. scan the escalation's existing thread (`list(context).filter(r => r.escalation_id === escalation_id)`)
     for an entry with that `provider_message_ref` → if found, return it (idempotent re-delivery no-op) —
     the ref-dedup decides IDENTITY;
  2. else allocate the slot STRICTLY ABOVE THE HIGH-WATER MARK: `seq = (max existing seq in thread) + 1`
     (0 if the thread is empty), NOT `thread.length` — **review P1 fix (doddy F1 / architect P1).**
     `thread.length` is a *guess* at a free slot that collides whenever the thread has a GAP (an operator
     POSTed a sparse/forged `seq` — `parseSeq` accepts any non-negative int, `seq` schema is `minimum:0`
     with no contiguity), silently dropping the guest turn (put-if-absent returns the occupant) or
     mis-merging. `max(seq)+1` is provably free (above every occupied slot) regardless of gaps. Then stamp
     `reply_id`/`sent_at` from the injected ids/clock, set `sender = 'guest'`, store the `provider_message_ref`;
  3. `put` (read-first-put-if-absent on the composite `${escalation_id}:${seq}` slot — the inherited net,
     now UNREACHABLE for a fresh ref since `max+1` is free) and validate against the `escalation_reply`
     contract. (Execution is synchronous/single-threaded — one inbound runs to completion before the next —
     so the architect's concurrent-distinct-ref case can't interleave; `max+1` is the belt, the sync model
     the suspenders.)
- The operator `append` (seq-keyed double-submit) is untouched — the two entry points share the repo and
  the composite-slot model but use DIFFERENT idempotency keys (seq for operator, provider_message_ref for
  guest), each documented.
- **Operator-vs-guest interleaving is handled by the EXISTING 409 path.** A guest turn that lands at slot
  `N` between an operator's page render (which showed length `N`) and their form submit (`seq=N`) makes
  the operator's slot taken with a DIFFERENT body → the Phase-34 `RESP_REPLY_CONFLICT` (409) → the
  operator re-renders, sees the guest turn, and their form now carries `seq=N+1`. No new machinery; the
  seq model already accommodates a second writer.

### C. Untrusted, UNBOUNDED guest text in a thread that caps operator text (the no-500 problem)

`escalation_reply.body` is `maxLength: 2000` (drift-guarded to equal the handler's
`REPLY_BODY_MAX_LENGTH`) — sound for OPERATOR replies (the cap is a cost/UX bound on text we *send* and
*bill*). But a guest's inbound `text` is `minLength: 1` with **NO maxLength** (byte-identical to
`inbound_webhook.text`, by the Phase-26 design that lets `guest_escalation.text` host any message that
passed the edge without a 500). Storing an unbounded guest body in a `maxLength:2000` field would make
`assertValid` throw on a long guest message → a swallowed capture / 500 oracle.

**Resolution — split the cap from the storage constraint (the dual-provenance fix):**
- `escalation_reply.body` now hosts TWO provenances: operator-typed (capped because billed/sent) and
  guest-received (unbounded, already passed the inbound edge). The schema must accept the UNION → DROP the
  `maxLength` (keep `minLength: 1`), exactly as `guest_escalation.text` is unbounded.
- The operator cap MOVES ENTIRELY to the handler: `handleEscalationReply` already 400s `reply_text` over
  `REPLY_BODY_MAX_LENGTH` BEFORE append, so an operator reply still can't exceed 2000 — the cap is a SEND
  bound (cost), not a storage bound. Guest turns never pass through that handler.
- **This STRENGTHENS the no-500 guarantee** and weakens no safety property: the 2000 was never a security
  bound, only a no-500 *alignment* for operator input; for guest input the requirement INVERTS (no cap so
  unbounded text validates). The drift guard is REPURPOSED: (1) assert `body` has NO `maxLength` (so a
  guest turn can never 500), and (2) keep the handler test that an over-cap operator `reply_text` 400s.

### D. The `sender` discriminant and the provider_message_ref contract

- `escalation_reply.sender` enum gains **`guest`** → `["planner","couple","guest"]`. Display metadata,
  never read for a decision (the render labels a `guest` turn distinctly).
- `escalation_reply` gains an OPTIONAL `provider_message_ref` (string, `minLength:1`), present **iff**
  `sender === 'guest'` (the guest turn's re-delivery dedup key; absent on operator turns). Enforce the
  discriminant with the codebase's `billing_event` allOf if/then/**else** idiom:
  `if sender:guest then required provider_message_ref else { not: { required: [provider_message_ref] } }`
  — the `else` FORBIDS the ref on operator turns (**review P1 fix, architect**: "not required" ≠
  "forbidden"; the `not:{required}` clause makes an operator turn carrying a smuggled ref FAIL validation,
  not silently validate). Test both halves (a guest turn without a ref 400s; an operator turn WITH a ref
  400s). This contract-pins the dual-provenance so an operator turn can never carry a ref and a guest turn
  always does.

### E. No new guest-observable behavior (no oracle) — the wire is unchanged

Every inbound branch STILL returns the uniform `RESP_ACCEPTED` (202). Threading-vs-fresh-escalation is a
purely server-side write decision, visible ONLY to the already-authorized couple/planner reading the
inbox — invisible to the guest. So it adds NO new guest-observable oracle (the same argument that lets
the escalation record itself be invisible). Untrusted guest `body` is HTML-escaped at render via the
existing `html` SafeHtml template (never reflected to the guest), exactly as `escalation.text` and
operator `body` already are.

## Design-review verdict (Step 0 — DONE)

Both lenses returned **APPROVE-WITH-FIXES**; no constructible cross-tenant / cross-wedding / cross-guest
exploit, no cost-amplification, no stored-XSS. Findings folded above (§B, §D) and into the steps:
- **P1 (both) — seq allocation:** `seq = max(existing seq)+1`, not `thread.length` (collides on gaps / a
  forged sparse operator seq → silent drop). Folded into §B + Step 2.
- **P1 (architect) — allOf forbid:** operator turns must FORBID `provider_message_ref` (`not:{required}`),
  not merely omit-required. Folded into §D + Step 1.
- **P2 (both) — render label:** `threadView`'s `sender` ternary is binary (`planner` else "Couple") → a
  `guest` turn would mislabel as "Couple". Must become an EXHAUSTIVE three-way map. Step 4, required+tested.
- **P2 (architect) — narrow `resolutions`:** type it `Pick<EscalationResolutionLog,'getByEscalationId'>`
  in `MessagingHandlerDeps` (inbound reads, never resolves — structural). Step 3.
- **P2 (architect) — drift guard:** the handler-400 test is now the SOLE operator cost-cap enforcement
  (the schema no longer caps); mark it so it's never deleted as "covered by the contract". Step 1.
- **P2 (architect) — `received_at` tiebreak** is for DETERMINISM only, not a recency guarantee. ADR note.
- **P2 (doddy) — timing:** the threaded path's extra scans disclose only the guest's OWN conversation
  state (already known to them) → not a meaningful oracle. ADR note. **P3s** (verb-asymmetry header doc,
  scan O(thread) note) folded into Step 2.

## Steps

### Step 1 — Schema + types + drift guard
- [x] `escalation_reply_schema.json`: `sender` enum `+= "guest"`; DROP `body.maxLength` (keep
  `minLength:1`, update the description to the dual-provenance story); add optional
  `provider_message_ref` (`string, minLength:1`); add the `allOf` discriminant (guest ⇒ required ref,
  operator ⇒ forbidden). Update the schema `description` (retire the "deferred inbound" sentence → now
  built; reference ADR 0035).
- [x] `npm run gen:types` → `EscalationReply` gains `sender:'guest'` + optional `provider_message_ref`.
  Manifest stays **21** (a MODIFY, not a new schema).
- [x] Update the drift guard in `escalation_reply_log.test.ts`: replace `body.maxLength === REPLY_BODY_MAX_LENGTH`
  with (1) `body.maxLength === undefined` (guest turns never 500) and (2) a handler test that an over-cap
  operator `reply_text` 400s — comment it as the **SOLE surviving enforcement of the operator cost cap**
  (the schema no longer caps; do not delete as "covered by the contract"). Add the allOf tests: a `guest`
  turn WITHOUT a `provider_message_ref` fails validation; an operator turn WITH one fails validation.
  Verify `npm run build && npm test && npm run lint`.

### Step 2 — `EscalationReplyLog.recordGuestReply`
- [x] Add `recordGuestReply(context, {escalation_id, wedding_id, provider_message_ref, body})`:
  ref-dedup scan → `seq = max(existing seq)+1` (0 if empty, **never length** — P1) → `sender:'guest'` +
  stored ref → put-if-absent + assertValid. Document in the file header: the two ENTRY POINTS are siblings
  appending to the SAME composite-slot thread but with DIFFERENT idempotency keys — operator `append` =
  client-supplied `seq` (form double-submit, 409 on body-mismatch at the handler); guest `recordGuestReply`
  = `provider_message_ref` (re-delivery), allocating its own slot above the high-water mark (the verb
  `record` signals "ref-keyed like `escalation_log.record`"). Note the dedup scan is O(thread) (same
  future-index caveat `getByEscalationId` documents).
- [x] Tests in `escalation_reply_log.test.ts`: a guest reply appends at the next seq with `sender:'guest'`
  + the ref; re-delivery (same ref) is idempotent (one row, stable reply_id); two distinct guest refs take
  consecutive seqs; a guest reply interleaves correctly with operator `append` (next seq after an operator
  turn); **a sparse/forged operator seq (a GAP) followed by a guest reply lands ABOVE the max seq and
  overwrites/drops nothing** (the P1 regression guard); cross-tenant isolation (a guest reply in tenant A
  is invisible to tenant B); liveness (a suspended tenant throws). Verify green.

### Step 3 — Inbound correlation in `handleInbound`
- [x] Add `resolutions: Pick<EscalationResolutionLog,'getByEscalationId'>` (read-only narrowing — inbound
  reads the open-status, never resolves — P2) + `replies: EscalationReplyLog` to `MessagingHandlerDeps`.
- [x] Add `EscalationLog.getByProviderRef(context, ref)` (O(1) `#repo.read` — the repo is keyed by the ref)
  and `EscalationReplyLog.guestTurnByProviderRef(context, ref)` (tenant scan for a guest turn carrying ref).
- [x] Add the module-private `mostRecentOpenEscalationForGuest(context, deps, wedding_id, from_ref)`
  selector (§A) — returns the target `GuestEscalation` or `undefined`. The `received_at` max-by pick uses
  a stable `escalation_id` tiebreak FOR DETERMINISM ONLY (not a recency guarantee — two escalations at the
  same tick are both that guest's open conversation; the choice is immaterial).
- [x] In the `escalated` branch, apply the §B0 PROCESS-ONCE gate FIRST (getByProviderRef + guestTurnByProviderRef
  → no-op on a re-delivery), THEN route (thread vs fresh-record). Tests must cover: re-delivery of a
  freshly-escalated message does NOT spawn a guest turn (the common break); a threaded follow-up's
  re-delivery after its escalation is RESOLVED does not spawn a fresh escalation (the cross-resolve break).
- [x] In `handleInbound`'s `escalated` branch: select the target; if found →
  `deps.replies.recordGuestReply(...)` (escalation_id/wedding_id COPIED from the live escalation,
  provider_message_ref/body from the validated message); else → the existing `escalations.record(...)`.
  Keep the uniform 202 on every path. Update the handler doc-comment.
- [x] Wire `resolutions` + `replies` into the `messaging:` bag in `compose.ts` (the SAME instances the
  escalation read/resolve/reply surface already uses).
- [x] Tests in `escalation_*` api/e2e: a follow-up from a guest with an OPEN escalation threads into it
  (sender:'guest', no new escalation, no send/charge); a follow-up with NO open escalation opens a fresh
  one (current behavior); a re-delivery of the threaded message is idempotent (one turn); a resolved
  escalation does NOT receive the follow-up (it opens a fresh escalation — resolved ≠ open); the
  cross-wedding re-bind case (a re-bound guest's message never lands in the old wedding's open thread);
  the answered follow-up still sends + does NOT thread (deferral pinned); the wire stays 202 on every
  branch. Verify green.

### Step 4 — Render guest turns in the thread
- [x] `pages.ts` `threadView`: replace the BINARY `sender` ternary (`planner` else "Couple") with an
  EXHAUSTIVE three-way map (`guest`→"Guest", `planner`→"Planner", `couple`→"Couple") — **P2 fix: today a
  `guest` turn would mislabel as "Couple" (a trust-presentation bug, operator mistakes a guest for the
  couple).** Still escaped via `html`, still sorted numerically by `seq`. The reply form's `seq =
  thread.length` is UNCHANGED (Phase-34 behavior, 409-protected): guest turns share the `replies` array and
  allocate contiguously (`max+1`), so `thread.length === max+1` in normal operation — the operator form
  still lands on the next free slot, and the only divergence (a forged-seq gap) stays 409-protected exactly
  as Phase 34 designed.
- [x] Update `pages.test` / the escalation web e2e: the thread renders an interleaved guest+operator
  conversation; a guest turn's body is HTML-escaped (XSS round-trip pinned); the reply form's hidden seq
  counts guest turns. Extend the existing demo e2e if a guest-follow-up path is exercisable end-to-end.
  Verify `npm run build && npm test && npm run lint` green.

### Step 5 — Docs + memory + handoff
- [x] ADR 0035 (guest-reply → thread correlation): the selector + dual-match defense, the two idempotency
  models, the dropped maxLength dual-provenance, the allOf discriminant, the no-oracle wire invariance,
  the recorded deferrals (answered-threading, time-window).
- [x] New memory `.claude/memory/guest-reply-thread-correlation.md` + index line in `MEMORY.md`; link
  [[multi-turn-reply-thread]], [[guest-escalation-inbox]], [[guest-messaging-channel-is-a-roadmap-goal]].
- [x] Update `.claude/handoff.local.md` (where we are, next lever, fresh context).
- [x] Final `npm run build && npm test && npm run lint` green; commit.

## Standing rails (unchanged)
Offline-first (no real money/booking/comms; no prod/credentials). A real provider sending real texts is
the human crossing — build to the line. Don't modify `ops/` or `CLAUDE.md`. Push only to `origin`.
Specialists not provisioned → route adversarial reviews through `general-purpose` carrying the persona
lens. Schema MODIFY ⇒ `npm run gen:types` (manifest stays 21). Eval/telemetry import ONLY
`@wedding-planner/shared`, never `product`. The web UI's only data path is `api.handle()`. Guest input is
UNTRUSTED → escape at render + no-oracle discipline. Verify per step; commit per verified step; never
commit to `main`.
