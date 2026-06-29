# Multi-turn console reply thread (Phase 34)

The guest-escalation inbox is now a conversation surface. A console reply (planner/couple) APPENDS to a
per-escalation **thread** and METERS a send **without resolving** — so an operator can send follow-ups while
the escalation stays OPEN; resolving/dismissing stays the explicit Phase-27 action. The thread is the
question→answer transcript the inbox renders. Builds on [[reply-from-inbox]] (Phase 28), [[reply-transcript]]
(Phase 29), [[guest-escalation-inbox]] (Phase 26), [[escalation-resolution]] (Phase 27). ADR 0034.

## The load-bearing decisions (carry forward)

- **Decoupling moved the double-submit guard.** Phase 28's single-charge guard was two-layered: PRIMARY =
  "a resolution already exists → no send"; the meter key was defense-in-depth. Decoupling removes the
  auto-resolve, so that primary guard can no longer stop a second reply (and must not). The new primary guard
  is a render-time **`seq`** (thread position): the form carries `seq = (current thread length)`; the
  `EscalationReplyLog` is a `TenantScopedRepository` keyed by the **composite `${escalation_id}:${seq}`**
  (read-first-put-if-absent); the meter key is `reply:${escalation_id}:${seq}` (now the defense-in-depth layer).

- **`seq` is a CLIENT-controlled KEY, safe like `provider_message_ref`.** It is the ONE persisted field whose
  value comes from the request body. Safe for the same reason `escalation_log`'s `provider_message_ref` is safe
  as a key: the repo partition is `context.tenant_id` ALONE, so a forged seq is **inert-or-self-harm** within
  the caller's own tenant (collides only with the caller's own slot; never another tenant's / another
  escalation's), and every NEW slot costs a real metered send (self-funded). channel/recipient/wedding_id/
  escalation_id all come from the LIVE escalation — a smuggled body field can't redirect a send.

- **Same-seq / DIFFERENT-body ⇒ `409`, NEVER a silent success** (doddy P1). The read-first finds the slot
  taken: same stored body → idempotent `{replied:true}` (true double-submit, no second send); different stored
  body → a lost-update (stale form / co-operator raced the slot) → `409` (retry from a fresh seq). This is the
  honest fix for the concurrent-distinct-operator collision — no nonce store needed. The 409 is reachable ONLY
  after the scope + open gates pass, so it discloses nothing new (no oracle). For the WEB flow the 409 is
  swallowed by the PRG redirect; the operator sees their message absent and the now-`seq+1` form lets them
  resend.

- **`seq` is validated existence-INDEPENDENTLY.** `parseSeq` requires a non-negative integer (number or numeric
  string), rejecting absent/negative/fractional/non-numeric/NaN/Infinity as ONE masked `PRODUCT.BAD_REQUEST`,
  fired BEFORE the escalation lookup → a malformed seq 400s byte-identically on absent vs present escalations.
  **Never default a missing seq to 0** (a defaulted seq is a dedup-collision/bypass vector).

- **The dismissed-no-bill keystone (Phase 28 F1/F2) STAYS.** The "already resolved/dismissed → RESP_REPLY_MISS,
  no send" gate is kept BEFORE the send. It no longer doubles as the double-submit guard, but it is NOT dead —
  it is why a closed escalation never dispatches a billed guest message. Statement order (PINNED):
  scope → absent/foreign-wedding miss → resolved/dismissed miss → **seq read-first** (idempotent / 409) →
  send → append. Append is commit-after-success; a structured send failure → RESP_REPLY_MISS (nothing
  appended), a non-structured bug → 500.

- **`escalation_reply` is the 21st schema; `escalation_resolution.reply_text` was RETIRED.** The thread owns the
  transcript, so the Phase-29 optional `reply_text` (+ its `allOf` dismissed-forbidden rule) was removed from
  the resolution (a resolution is again a pure handled-marker). The Phase-29 security argument transferred
  verbatim to `escalation_reply.body`; the no-500-oracle drift guard MOVED with it (now pins
  `body.maxLength === REPLY_BODY_MAX_LENGTH`, the constant renamed from `REPLY_TEXT_MAX_LENGTH`). Schema-add ⇒
  `gen:types` + manifest 20→21 (count test + title prose + gen-script header).

- **WIRE field ≠ SCHEMA field.** The request/discriminator field stays `reply_text` (so `dispatchEscalations`'
  presence discriminator is unchanged); only the schema field is `body`. Do NOT "consistency-rename" the wire
  field — it silently breaks the discriminator (guarded by a comment).

- **The read is a 3-array compose, scoped identically.** `handleEscalationList` returns
  `{escalations, resolutions, replies}`, all three by the SAME `manageScope` branch (planner whole-tenant,
  couple their-wedding) — a couple never reads a sibling wedding's thread. The render builds the thread index
  from the ALREADY-SCOPED `replies` array (never a request-supplied escalation_id), sorts NUMERICALLY by `seq`
  (`a.seq - b.seq`, never lexicographic, never array-indexed by seq). `countOpenEscalations` stays
  **reply-agnostic** (open = no resolution; a replied-but-unresolved escalation still needs attention).

## Deferred (recorded)

- **Guest-reply → thread correlation** — a guest texts back and it lands in the thread. The provider port
  carries only opaque refs and no conversation id (a guest texts in with a `from_ref`, no escalation/thread
  id), so this is a separate design problem. The inbound webhook is unchanged (a fresh question → a fresh
  escalation). Most-cited next lever on the guest-messaging arc.
- Rejected alternatives (ADR 0034): a server-minted per-form nonce store (adds an id source to the web layer
  for a corner case the 409 already makes honest); a content-hash key (would silently dedup a legit identical
  repeat answer — a more common case than the race it fixes).
