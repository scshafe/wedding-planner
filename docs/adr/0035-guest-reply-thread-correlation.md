# ADR 0035 — Guest-reply → thread correlation (inbound follow-ups land in the open thread)

- **Status:** accepted
- **Date:** 2026-06-29
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-29-phase-35-guest-reply-correlation.md`)
- **Scope:** Phase 35 — close the deferred half of multi-turn. Until now every inbound guest message the
  platform could not answer (`escalated`) opened a **fresh** escalation, so a guest texting a follow-up while
  their question was still OPEN spawned a *second* escalation. This rung makes an inbound `escalated` follow-up
  **land in the guest's most-recent OPEN escalation's reply thread** as a `sender:'guest'` turn, so the inbox
  shows the real back-and-forth (guest asks → operator replies → guest replies → operator replies → resolve).
  A guest turn is a RECEIVED message recorded into the conversation — **no send, no charge**.
- **Builds on** the multi-turn reply thread ([[multi-turn-reply-thread]], ADR 0034), the escalation inbox
  ([[guest-escalation-inbox]], ADR 0026), escalation resolution ([[escalation-resolution]], ADR 0027), the
  guest inbound edge ([[guest-messaging-inbound-edge]], ADR 0019), and couple-scoped guest management
  ([[couple-scoped-guest-management]], ADR 0024). The next rung of [[guest-messaging-channel-is-a-roadmap-goal]].
- **Explicitly deferred (recorded):** (1) threading the `answered` follow-up — an auto-answerable follow-up
  still sends its metered auto-reply but does NOT thread / does NOT auto-resolve the open escalation (correlation
  handles only the `escalated`, i.e. conversational, branch); (2) a correlation time-window — we thread into ANY
  open (unresolved) escalation for that guest+wedding, not only a recent one ("open" is the gate; a window is a
  magic constant + a clock read for marginal benefit, and adding one later is a pure filter tightening).

## Context

The provider-agnostic messaging port carries only opaque refs (`from_ref`, `provider_message_ref`) and **no
conversation/thread id** — a guest texts in with a `from_ref`, nothing tying it to escalation E1. So the target
escalation must be **inferred server-side from trusted domain state**, never from the guest's payload. Three
genuine problems had to be solved: (A) inferring the target without a conversation id and without cross-wedding
mis-segmentation; (B) reconciling two different idempotency models (operator = form `seq`; guest = provider
re-delivery) on one composite-keyed thread; (C) hosting unbounded untrusted guest text in a field that capped
operator text. A fourth — (D) re-delivery routing instability — surfaced during build and is the load-bearing
correctness fix.

## Decision

### A. Correlation WITHOUT a conversation id — the (from_ref ∧ bound-wedding ∧ open ∧ most-recent) selector

`mostRecentOpenEscalationForGuest(context, deps, binding.wedding_id, message.sender_ref)` returns the guest's
most-recent OPEN escalation in their CURRENTLY-BOUND wedding, or `undefined`. It filters the bound wedding's
escalations to `from_ref === sender_ref` and to those with no resolution (OPEN = the same join the inbox uses),
then picks the max by `received_at` (ISO-8601 fixed-width; stable `escalation_id` tiebreak **for determinism
only**, not a recency guarantee). If a target exists → thread; else → record a fresh escalation.

**The DUAL match (from_ref AND bound-wedding) is the cross-wedding mis-segmentation defense.** A `recipient_ref`
is the registry's tenant-GLOBAL key bound to ONE wedding at a time (the registry rejects a duplicate ref, so the
single-binding invariant is structural), but a planner can re-bind it (remove from wedding A, register to B).
Old escalations carry `wedding_id = A`; the live binding says `B`. Filtering candidates by `binding.wedding_id`
(the CURRENT trusted binding) excludes the A-escalations, so a re-bound guest's message can only ever reach an
open escalation in their *current* wedding. Both axes are TRUSTED state (the live binding + the recorded
escalation), never the inbound body — a guest supplies no targeting field that survives to the selector, so a
guest can only ever append to THEIR OWN conversation.

### B. Two idempotency models on one thread — `recordGuestReply` (ref-keyed) beside `append` (seq-keyed)

An operator reply dedups by the client-carried `seq` (a form re-POST; same-seq/different-body → 409 at the
handler). A guest reply has no form and no seq — a provider **re-delivery** carries the same
`provider_message_ref`. So `EscalationReplyLog.recordGuestReply` dedups by ref (scans the thread) and allocates
its slot **strictly above the thread's high-water mark** (`max(seq)+1`, 0 if empty) — **never `thread.length`**,
which would land inside a gap left by a forged/sparse operator seq (`parseSeq` accepts any non-negative int;
`seq` is `minimum:0` with no contiguity) and silently overwrite/drop a turn (the design-review P1 both lenses
raised). `max+1` is provably free of every occupied slot. The verb `record` (vs `append`) signals "ref-keyed,
like `escalation_log.record`."

### B0. The PROCESS-ONCE gate — re-delivery routing instability (the load-bearing correctness fix)

The split routing (thread-or-record) makes a per-thread ref-scan INSUFFICIENT, because the selector's output can
change between provider re-deliveries:
- **The common break:** a brand-new escalated question finds no open escalation → records a fresh escalation
  `E_new` (now OPEN). A re-delivery of that SAME message would re-run the selector, pick `E_new` (open), and
  thread the re-delivery as a spurious guest turn (`E_new`'s thread is empty, so the per-thread scan misses it).
- **The cross-resolve break:** a follow-up threads into `E_new`; `E_new` is resolved; the follow-up re-delivers
  → no open escalation → a fresh escalation duplicates the threaded turn.

**Fix:** gate the escalated branch on TWO "already processed?" reads BEFORE routing —
`escalations.getByProviderRef(ref)` (the EscalationLog repo is keyed by `provider_message_ref`, so this is an
**O(1)** read) and `replies.guestTurnByProviderRef(ref)` (a tenant scan for a guest turn carrying the ref). A
ref already recorded as an escalation OR as a guest turn is a no-op. This is the escalated-branch analogue of the
answered branch's top-of-handler `receipts.seen(ref)` short-circuit — each side-effect log still owns its own
idempotency (no widening of the doddy-P0 receipt log); the gate just consults BOTH escalated-side logs before
routing. Enumerated, every case collapses to exactly one record per inbound ref.

### C. Unbounded guest text in a capped field — drop `escalation_reply.body.maxLength`

`escalation_reply.body` now hosts two provenances: operator-typed (capped because the message is *sent* and
*billed*) and guest-received (unbounded, already passed the inbound edge — byte-identical in constraint to
`inbound_webhook.text` / `guest_escalation.text`: `minLength:1`, NO `maxLength`). The schema must accept the
union → the `maxLength` was **dropped**. The operator cost cap moves entirely to the handler
(`handleEscalationReply` 400s an over-cap `reply_text` before append) — a SEND/cost bound, not a storage bound,
and now the **sole surviving** enforcement of it (marked so in the test so it is never deleted as "covered by
the contract"). This STRENGTHENS the no-500 guarantee (a long guest message can never fail validation) and
weakens no safety property (the 2000 was never a security bound).

### D. The `sender` discriminant and the provider_message_ref contract

`escalation_reply.sender` gains `guest` (`["planner","couple","guest"]`). `escalation_reply` gains an OPTIONAL
`provider_message_ref` (the guest turn's re-delivery dedup key), present **iff** `sender === 'guest'`, enforced
with the codebase's `billing_event`-style allOf if/then/**else** (guest ⇒ required; operator ⇒
`not:{required}` = FORBIDDEN). So the ref's presence is itself the trusted guest/operator discriminant and an
operator turn carrying a smuggled ref fails validation.

### E. No new guest-observable behavior (no oracle)

Every inbound branch still returns the uniform `RESP_ACCEPTED` (202). Threading-vs-fresh-escalation is a
server-side write decision visible only to the already-authorized couple/planner reading the inbox — invisible
to the guest, so no new guest-observable oracle (the same argument that lets the escalation record itself be
invisible). The threaded path's extra reads disclose only the guest's OWN conversation state (which they already
know), so the timing delta between "has an open escalation" and "doesn't" is not a meaningful oracle. The
untrusted guest `body` is HTML-escaped at render via the existing `html` SafeHtml template (an exhaustive
three-way sender label avoids mislabeling a guest turn as "Couple") and is never reflected back to the guest.

## Consequences

- The escalation inbox is now a true bi-directional conversation: guest turns interleave with operator turns in
  one thread, keyed by `escalation_id`, ordered by `seq`.
- The reply log has two write entry points with different idempotency keys; both append to the same
  composite-slot thread. `EscalationLog.getByProviderRef` (O(1)) and `EscalationReplyLog.guestTurnByProviderRef`
  back the process-once gate.
- `MessagingHandlerDeps` gains `resolutions` (Pick-narrowed to `getByEscalationId` — inbound reads the
  open-status, never resolves) and `replies`; compose wires the same instances the escalation surface uses.
- `escalation_reply` is a MODIFY (manifest stays 21): `sender` += `guest`, `body.maxLength` dropped, optional
  `provider_message_ref` + the allOf discriminant.
- **Reviewed** at design (both lenses APPROVE-WITH-FIXES; all P1/P2 folded) and during build (the §B0
  routing-instability bug was self-caught beyond the review and fixed). No constructible cross-tenant /
  cross-wedding / cross-guest exploit, no cost-amplification, no stored-XSS.
- **Deferred:** answered-follow-up threading; a correlation time-window; reopening a resolved escalation.

See `.claude/memory/guest-reply-thread-correlation.md` and
`.claude/plans/2026-06-29-phase-35-guest-reply-correlation.md`.
