---
name: reply-from-inbox
description: Phase 28 — console-initiated metered reply to an escalated guest that auto-resolves the escalation; the no-oracle + single-charge keystone
metadata:
  type: project
---

# Reply-from-the-inbox (Phase 28)

The couple (their wedding) / planner (whole tenant) can **answer an escalated guest directly from the inbox**.
The operator types a reply; the platform sends it to the guest's `from_ref` over the guest's channel through
`MessagingService.send` (**metered + billed** — the FIRST console-initiated send, not the inbound webhook) and
**auto-records a `resolved` resolution** (resolve-by-replying). JSON `POST /t/:slug/escalations` with a
`reply_text` body + a CSRF-gated 4-seg browser Reply form. ADR 0028. Builds on [[escalation-resolution]] (the
record it writes), [[guest-escalation-inbox]], [[guest-messaging-port-and-meter]] (the firewall),
[[guest-messaging-inbound-edge]] (commit-after-success), [[planner-guest-management-and-csrf]] (CSRF).

## The load-bearing insights (carry forward)

- **The reply needs the inbound channel, which the escalation now stores.** A 6th use of the canonical
  `Channel`: `channel` is a REQUIRED field on `guest_escalation` (the 20th schema, MODIFY not new — manifest
  stays 20), copied from the validated inbound `message.channel` at `record()` time — the reply-routing
  snapshot. Drift-guarded by a `GuestEscalation['channel']` `Exact<>` line in `channel.test.ts`. The guest
  registry binding has NO channel; re-deriving at reply time is impossible — the escalation is the right home.

- **The reply is SCOPED like resolve, not a capability.** `getByEscalationId` (tenant-scoped) → absent OR a
  couple's foreign-wedding escalation → ONE shared frozen `RESP_REPLY_MISS` (`{replied:false}`) returned BEFORE
  any send/charge/record. Separate constant from `RESP_RESOLVE_MISS` (body key `replied` vs `resolved`).
  Byte-identity is STRUCTURAL (shared constant), not test-hoped.

- **The send is gated on NO prior resolution existing** (`EscalationResolutionLog.getByEscalationId`, an O(1)
  read of the `escalation_id`-keyed partition, reached ONLY after the scope gate so it's not an oracle). This
  is doddy's F1/F2 fix: (a) an already-**dismissed** escalation can never dispatch a billed message to an
  ignored guest; (b) a double-submit with a different `reply_text` is a single send (the 2nd attempt sees it
  handled → `{replied:false}`, honest, not a silently-dropped `{replied:true}`). Reply is **Open-only** by
  construction (the UI shows the Reply form only on Open rows).

- **Single-charge is also structural via the DETERMINISTIC meter key `reply:${escalation_id}`** (defense in
  depth behind the resolution gate). Platform-derived, never the body; tenant-namespaced; the `reply:`
  colon-prefix is disjoint from the inbound `mintReplyId()` `inbound_…` underscore-prefix. Unlike the inbound
  path (fresh key per delivery — no stable caller key), the console reply HAS a stable trusted key (the
  escalation id), so deterministic is correct + better. First accepted reply body wins; a re-submit is a no-op.

- **Body provenance:** the handler reads ONLY `escalation_id` + `reply_text` from the body. `channel` +
  `recipient_ref` come from the LIVE escalation, `tenant_id` from the context, the resolution's `wedding_id`
  copied from the live escalation, `resolved_by` from `principal.role`. A smuggled body field is inert. The
  discrimination `body.reply_text !== undefined` is a pure body-shape function evaluated before field
  validation (no parse-outcome oracle). `REPLY_TEXT_MAX_LENGTH` (2000) is a trusted-operator hygiene cap that
  400s BEFORE the lookup.

- **Commit-after-success:** send FIRST, then resolve. A structured `WeddingPlannerError` from the send
  (margin/cost) → `RESP_REPLY_MISS` (Open + retryable, no resolution recorded; the deterministic key stays
  free so a retry re-sends). NOT swallowed to 202 (the caller is an authed operator — no oracle to protect),
  but a genuine bug still 500s. The catch is narrowed to `WeddingPlannerError`.

- **Channel is GUEST-chosen** → a per-channel cost-amplification, **bounded** by the strict-margin gate (a
  non-positive-margin channel refuses to send). Not a leak, not an oracle (the guest knows their own channel).
  A reply-channel policy override + a persisted reply transcript are recorded future rungs.

- **CSRF at the web layer only.** The 4-seg `POST /t/:slug/escalations/reply` form (slug-masked before CSRF;
  forged → 403 no send) delegates to the 3-seg JSON route (Bearer-only, not CSRF-reachable). `compose` wires
  the SAME `MessagingService` into the escalations deps, so console + guest replies meter through one ledger.
  `EscalationHandlerDeps` is now READ-WRITE: `escalations` + `resolutions` + `authorizer` + `service`.

doddy + architect APPROVE-WITH-FIXES on the design (no exploit); doddy re-review of the BUILT code APPROVE,
clean. 858 tests green.
