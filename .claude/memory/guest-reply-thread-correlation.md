# Guest-reply → thread correlation (Phase 35)

The guest-escalation inbox is now a BI-DIRECTIONAL conversation. An inbound guest message the platform can't
answer (`escalated`) that comes from a guest who already has an OPEN escalation in their CURRENTLY-BOUND wedding
**threads into that escalation** as a `sender:'guest'` turn instead of opening a new escalation; only a
genuinely new conversation opens a fresh escalation. A guest turn is a RECEIVED message recorded into the
conversation — **no send, no charge** (only operator replies meter). Closes the deferred half of
[[multi-turn-reply-thread]] (Phase 34); builds on [[guest-escalation-inbox]] (26), [[escalation-resolution]]
(27), [[guest-messaging-inbound-edge]] (19). ADR 0035.

## The load-bearing decisions (carry forward)

- **Correlation is INFERRED server-side — the port has no conversation id.** The selector
  `mostRecentOpenEscalationForGuest(context, deps, binding.wedding_id, message.sender_ref)` intersects
  `from_ref === sender_ref` AND `wedding_id === binding.wedding_id` (the CURRENT trusted binding) AND OPEN
  (no resolution), picks max by `received_at` (ISO fixed-width; `escalation_id` tiebreak for DETERMINISM only).
  The guest supplies NO targeting field that survives to the selector → a guest can only ever append to THEIR
  OWN conversation.

- **The DUAL match (from_ref AND bound-wedding) is the cross-wedding mis-segmentation defense.** A
  `recipient_ref` is the registry's tenant-global key bound to ONE wedding at a time (register rejects a dup ref
  → single-binding invariant is structural), but a planner can RE-BIND it (remove from A, register to B). Old
  escalations carry `wedding_id = A`; filtering candidates by the LIVE `binding.wedding_id` excludes them, so a
  re-bound guest's message can only reach an open escalation in their *current* wedding.

- **Two idempotency models on ONE composite-keyed thread.** Operator turn = client `seq` (form re-POST;
  same-seq/different-body → 409 at the handler). Guest turn = `provider_message_ref` (provider re-delivery):
  `EscalationReplyLog.recordGuestReply` dedups by ref (thread scan) and allocates the slot
  **`max(seq)+1`, NEVER `thread.length`** — length lands inside a gap left by a forged/sparse operator seq
  (`parseSeq` accepts any non-neg int; `seq` is `minimum:0`, no contiguity) and would silently overwrite/drop a
  turn. `max+1` is provably free. (Both review lenses raised this as P1.)

- **THE PROCESS-ONCE GATE — re-delivery routing instability (self-caught; BOTH review agents MISSED it).** The
  split routing makes a per-thread ref-scan INSUFFICIENT: a freshly-recorded escalation `E_new` is OPEN, so a
  re-delivery of the SAME message would otherwise be threaded INTO it (the common break); and a since-resolved
  escalation drops a re-delivered follow-up to a fresh escalation (the cross-resolve break). FIX: gate the
  escalated branch on TWO reads BEFORE routing — `escalations.getByProviderRef(ref)` (O(1) — the EscalationLog
  repo is keyed by `provider_message_ref`) + `replies.guestTurnByProviderRef(ref)` (tenant scan). A ref already
  recorded as an escalation OR a guest turn → no-op. The escalated-branch analogue of the answered branch's
  `receipts.seen(ref)`; no widening of the doddy-P0 receipt log (each side-effect log keeps its own idempotency,
  the gate consults both). **Whenever a side-effect splits across two logs by a runtime decision, the dedup must
  be checked across BOTH before the write — a per-target scan can't see the other target.**

- **`escalation_reply.body` lost its `maxLength` — dual-provenance.** The field now hosts operator-typed
  (capped because SENT/billed) AND guest-received (unbounded, already passed the inbound edge — byte-identical
  to `inbound_webhook.text` / `guest_escalation.text`, `minLength:1` NO max). Schema must accept the union → no
  `maxLength`, so a long guest message can never fail validation (no 500 oracle / no swallowed capture). The
  operator cost cap moved ENTIRELY to the handler (`REPLY_BODY_MAX_LENGTH`, the SOLE surviving enforcement — a
  test marks it so it's never deleted as "covered by the contract"). The Phase-34 drift guard
  (schema-max == handler-cap) was REPLACED by "schema body has NO maxLength".

- **`sender` += `guest`; optional `provider_message_ref` present IFF `sender:'guest'`** — enforced by the
  `billing_event`-style allOf if/then/**else** (guest ⇒ required; operator ⇒ `not:{required}` = FORBIDDEN), so
  the ref's presence is the trusted guest/operator discriminant and an operator turn smuggling a ref fails
  validation. `escalation_reply` is a MODIFY (manifest stays 21).

- **No new oracle.** Every inbound branch still returns the uniform 202 → threading-vs-fresh is invisible to the
  guest. The threaded path's extra reads disclose only the guest's OWN conversation state (already known to
  them). Untrusted guest body HTML-escaped at render (exhaustive three-way sender label: guest/planner/couple —
  a binary `planner`-else ternary would mislabel a guest turn as "Couple", a trust-presentation bug).

- **`MessagingHandlerDeps`** gains `resolutions: Pick<…,'getByEscalationId'>` (read-only — inbound NEVER
  resolves, narrowing makes it structural, mirrors `BillingHandlerDeps`) + `replies`.

## Deferred (recorded in ADR 0035)
- Threading the `answered` follow-up (an auto-answer sends but does NOT thread / does NOT auto-resolve).
- A correlation time-window (we thread into ANY open escalation, not only a recent one — "open" is the gate).
- Reopening a resolved escalation.
