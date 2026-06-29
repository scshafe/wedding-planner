# ADR 0034 — Multi-turn console reply thread (decouple reply from resolve)

- **Status:** accepted
- **Date:** 2026-06-28
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-28-phase-34-multi-turn-reply-thread.md`)
- **Scope:** Phase 34 — make the guest-escalation inbox a real conversation surface. Until now a console reply
  (Phase 28) sent exactly ONE metered message per escalation and AUTO-resolved it, so an operator got one shot
  per question. This rung **decouples reply from resolve**: an operator (planner/couple) can send **multiple
  follow-up replies** on an OPEN escalation — a per-escalation **thread** — and resolving/dismissing stays the
  explicit Phase-27 action. The thread is the question→answer transcript the inbox renders.
- **Builds on** the escalation inbox ([[guest-escalation-inbox]], ADR 0026), escalation resolution
  ([[escalation-resolution]], ADR 0027), reply-from-the-inbox ([[reply-from-inbox]], ADR 0028), the reply
  transcript ([[reply-transcript]], ADR 0029), and the messaging meter/firewall ([[guest-messaging-port-and-meter]],
  ADR 0018). The next rung of [[guest-messaging-channel-is-a-roadmap-goal]].
- **Explicitly deferred:** guest-reply → thread correlation (a guest texts back and it lands in the thread). The
  provider-agnostic port carries only opaque refs and no conversation id (a guest texts in with a `from_ref`,
  no escalation/thread id), so inbound correlation is a separate design problem. The inbound webhook keeps its
  current behavior (a fresh question → a fresh escalation).

## Context

Reply-from-the-inbox (Phase 28) coupled two facts that are really separate: "the operator answered the guest"
and "the question is handled." Auto-resolve-on-reply meant a single answer closed the loop — fine for a one-shot
fact, useless for a back-and-forth ("which lot?" → "Lot B" → "by the chapel?"). The most-cited open thread in
the Phase-33 handoff was to give the inbox a multi-turn message log.

The hard part is NOT the thread; it is what replaces Phase 28's double-submit guard. Phase 28's single-charge
guard was two-layered: the PRIMARY guard was "a resolution already exists → no send"; the meter key
`reply:${escalation_id}` was defense-in-depth. Decoupling removes the auto-resolve, so the resolution-existence
guard can no longer stop a second reply (and must not — multi-turn is the point). A new per-message double-submit
story was required.

An adversarial **design** review ran first (a `general-purpose` agent carrying the doddy + rigorous-architect
lens — the named specialists are not provisioned here): verdict **APPROVE-WITH-FIXES, no exploit**; all P1/P2
folded before building. A **built-code** review of the committed reply path followed: **APPROVE — no
constructible exploit**, all eight claimed properties verified at file:line. 953 tests green (was 945 at phase
start).

## Decision

### 1. Decouple: a reply appends to a thread and does NOT resolve

A reply APPENDS one operator message to the escalation's thread and METERS a send; it no longer writes a
resolution. The escalation stays **OPEN** until an explicit resolve/dismiss (Phase 27, unchanged). The Phase-28
**"already handled (resolved OR dismissed) → no send"** gate STAYS — it now means *"a closed escalation accepts
no further reply,"* which preserves the doddy F1/F2 keystone that a **dismissed escalation can never dispatch a
billed guest message**. It no longer doubles as the double-submit guard, but it is not dead.

### 2. The double-submit guard moves to a render-time `seq` (thread position)

- The reply form for an escalation that currently has **N** replies carries a hidden `seq = N`
  (`= repliesFor(escalation_id).length`) — a projection of the SAME scoped read that renders the page, so the
  web layer needs no new dependency / no id source (only-data-path-is-`api.handle` preserved).
- The new `EscalationReplyLog` is a `TenantScopedRepository` **keyed by the composite `${escalation_id}:${seq}`**.
  `append` is read-first-put-if-absent on that slot; the send's `idempotency_key` is `reply:${escalation_id}:${seq}`
  (the per-tenant meter is defense-in-depth, the slot read is the primary guard).
- A **double-submit** (re-POST of the same rendered form, same seq + same body) returns the existing reply →
  idempotent `{replied:true}`, **no second send**. A genuine follow-up renders a fresh `seq=N+1` form → a new
  slot → a new send.
- **Same-seq / DIFFERENT-body ⇒ `409`, not a silent success** (doddy P1, the integrity fix). The read-first
  finds the slot taken: same stored body → idempotent success; different stored body → a lost-update (a stale
  form / a co-operator raced the slot) → `409` (retry from a fresh form), never a `{replied:true}` lie. For the
  WEB flow the 409 is swallowed by the PRG redirect; the operator lands back on the inbox, sees their message
  absent, and the now-`seq=N+1` form lets them resend.

**Why a client-carried `seq` is safe.** `seq` is the ONE persisted field whose value originates in the request
body — a *client/external-controlled KEY*, safe for exactly the reason `escalation_log`'s `provider_message_ref`
is safe as a key: the repository partition is `context.tenant_id` ALONE, so a forged seq is **inert-or-self-harm**
within the caller's own tenant (it can collide only with the caller's own slot — never another tenant's or
another escalation's), and every NEW slot costs a real metered send (self-funded). channel/recipient/wedding_id/
escalation_id all still come from the LIVE escalation, so a smuggled body field can't redirect a send.

**`seq` validation is existence-independent.** `parseSeq` requires a non-negative integer (a number or a numeric
string), rejecting undefined/absent, negative, fractional, non-numeric, NaN, Infinity uniformly as one masked
`PRODUCT.BAD_REQUEST`, fired BEFORE the escalation lookup — so a malformed seq on an absent escalation 400s
byte-identically to one on a present escalation. A missing seq is **never defaulted to 0** (a defaulted seq is a
dedup-collision/bypass vector).

### 3. The 21st schema `escalation_reply`; retire `escalation_resolution.reply_text`

`escalation_reply` = `{reply_id, tenant_id, escalation_id, wedding_id, seq, sender, body, sent_at}`. The thread
now OWNS the transcript, so the Phase-29 optional `reply_text` (and its `allOf` dismissed-forbidden rule) was
REMOVED from `escalation_resolution` — a resolution is again a pure handled-marker. The Phase-29 security
argument (trusted operator input, HTML-escaped at render, never reflected to the guest, length-capped +
drift-guarded, no-500-oracle from a maxLength that equals the handler cap) transferred verbatim to
`escalation_reply.body`; the drift-guard test MOVED with it (now pins `body.maxLength === REPLY_BODY_MAX_LENGTH`,
the constant renamed from `REPLY_TEXT_MAX_LENGTH`). No data migration (stores are in-memory, reset per process).

**Wire-field pin:** the request/discriminator field stays named `reply_text` (so `dispatchEscalations`'
presence discriminator is unchanged); only the *schema* field is `body`. A "consistency-rename" of the wire
field would silently break the discriminator — guarded by a comment.

### 4. The read returns a third scoped array; the render shows the thread

`handleEscalationList` returns `{escalations, resolutions, replies}` — all three scoped by the SAME `manageScope`
branch (planner whole-tenant, couple their-wedding), so a couple never reads a sibling wedding's thread. The
inbox renders each escalation's thread (built from the already-scoped `replies` array, sorted NUMERICALLY by
`seq`, never array-indexed by it — a forged far-future seq is a harmless display gap). `countOpenEscalations`
stays **reply-agnostic**: open = no resolution; a replied-but-unresolved escalation still counts as
needs-attention.

## Alternatives considered

- **A server-minted per-form nonce store** (each render mints a unique nonce; key on it). Rejected: it would add
  an id source to the web layer for a corner case the render-time `seq` + the 409 already make honest and
  retryable, and it would break the only-data-path-is-`api.handle` minimalism.
- **A content-hash key** (`${escalation_id}:${hash(body)}`). Rejected: it would let two distinct bodies coexist
  but would SILENTLY dedup a legitimate *identical* repeat answer ("Yes, parking is free" twice) — a more common
  console action than the distinct-operator race it would fix — and it loses the natural monotonic thread order.
- **Keep auto-resolve on the first reply, allow follow-ups to a resolved escalation.** Rejected: it reintroduces
  exactly the "billed reply to a resolved/dismissed escalation" risk Phase 28 deliberately closed.

## Consequences

- **A known, now-HONEST limitation:** two distinct operators (planner + couple) both at `seq=N` submitting
  different bodies collide — the second gets a `409` and resends from a fresh `seq=N+1` (no silent lost-update).
  Within the shared trust zone an operator can also pre-occupy a slot out-of-band to suppress a co-operator's
  later reply at that slot — fail-closed (a suppressed send never happens, never a forged send), self-tenant
  only, and the 409 makes any such drop observable rather than silent. Acceptable; not a trust-boundary break.
- The reply UX is now two-action (reply, then resolve) where it used to be one — intentional, the price of
  multi-turn; both the reply form and resolve buttons sit on the same OPEN row.
- The inbound webhook is unchanged (guest-reply correlation deferred). Manifest is now 21 schemas.
