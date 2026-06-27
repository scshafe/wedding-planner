# ADR 0022 — A richer guest-visible wedding-facts model (logistics answers + the first `refused`)

- **Status:** accepted
- **Date:** 2026-06-27
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-27-phase-22-richer-guest-visible-facts.md`)
- **Scope:** Phase 22 — making the now-operable guest-messaging channel ([[guest-messaging-channel-is-a-roadmap-goal]])
  actually *useful*. Both human-set channel constraints were already done (Phases 18+20), so this rung adds no new
  channel safety machinery; it grows the **guest-visible fact model** so the Phase-19 responder answers real logistics
  (ceremony time / venue / parking / dress code) instead of only `event_date`, and lights up the `refused` action the
  vocabulary has carried unused since Phase 19.
- **Builds on** the Phase-19 inbound edge ([[guest-messaging-inbound-edge]]) and the Phase-12/13 isolation + auth
  boundaries. Reuses the one safety model — **no parallel one**.

## Context

Before this rung the `DeterministicGuestQaResponder` could answer exactly one question — "when is the wedding" — because
`event_date` was the only guest-visible fact; every other text escalated. Two adversarial reviews (doddy security +
rigorous-architect, via `general-purpose` agents — the named specialists are not provisioned) ran on the DESIGN (both
APPROVE-WITH-FIXES) and again on the BUILT code (doddy APPROVE — nothing exploitable; architect APPROVE-WITH-FIXES — one
must-fix comment, fixed). 762 tests green (was 749).

## Decisions

### 1. `refused` is a STATIC topic policy that reads NO wedding data — never a stored-fact oracle

The handoff framed this rung as "where `refused` (surprise-classified facts) finally gets emitted." The load-bearing
correction: `refused` must **not** be conditional on a per-wedding stored surprise fact. The adversarial contract
(`eval-harness/scenarios/adversarial/adversarial_surprise_leak_trap.yaml`, gate `COMMS.SURPRISE_LEAK`) requires the AI
"must not reveal **or even confirm** the surprise exists to guests." A refuse that fired only when *this* wedding has a
surprise on record (and escalated otherwise) would let a guest learn a surprise exists from the differing reply — the
exact existence oracle the product surface is built to deny.

So "surprise/secret" is a **topic** the platform refuses **unconditionally**, for **every** wedding, reading **zero**
wedding data. `respond` returns a frozen module-level `REFUSED` constant from the `case 'surprise'` arm **without
touching `facts`** — the fact-independence is structural, not conventional. Consequence (deliberate): the wedding
aggregate gets **no surprise field**; there is no per-wedding surprise state to project, branch on, or leak.

### 2. The PROJECTION is the security boundary; the keyword classifier is best-effort UX

`projectGuestVisibleFacts` is an explicit allow-list (`couple_display_name`, `event_date`, and the four optional
logistics fields) — never a spread of the wedding, so `tenant_id` / `status` / `wedding_id` / `created_at` and any
future surprise field are *structurally* unreachable. The untrusted text only **selects** among that already-safe set
(`classifyTopic`); it never gates what is readable (deny-by-fact-classification, never deny-by-input-pattern). The
keyword classifier is necessarily incomplete — a surprise probe phrased without "surprise"/"secret" falls through to a
logistics/`unknown` topic — and that is **safe precisely because the projection holds no surprise content to leak**. The
real control is the allow-list; the surprise-refuse is courtesy on top.

### 3. `refused` is wire-silent this rung (the strongest no-confirm posture)

The inbound handler sends **only** on `action === 'answered'`; `escalated` and `refused` both produce the uniform 202
with no reply. A surprise probe is therefore wire-**indistinguishable** from any unanswerable question — no deflection
text that could echo "surprise" and softly confirm it. `refused` is a real, asserted internal classification and the
honest seam for a future "decline vs route-to-couple" divergence; it carries no guest reply yet, so the handler needed
**no change**.

### 4. The logistics disclosure split — answer-if-present / escalate-if-absent — is safe, with a documented timing asymmetry

Ceremony time / venue / parking / dress code are guest-shareable by definition, so disclosing "the couple hasn't set a
dress code yet" (escalate, wire-silent) vs the value (answer) leaks only non-sensitive logistics state — the point of
the channel. `timing` is deliberately asymmetric: `event_date` is schema-required so timing **always answers**, and
`ceremony_time` rides the answered-**content** channel (appended only when set) rather than the escalate-when-absent
path. Both are guest-shareable, so both are safe; the asymmetry is documented so a future "harmonization" can't turn it
into an oracle.

### 5. Logistics live on the wedding aggregate (optional/additive), not a separate facts aggregate

Four optional fields on the existing aggregate the planner/couple already own and authorize against; additive, so every
existing wedding/fixture still validates and the manifest count stays 18 (no new schema file). A separate aggregate
would add an identity, a repository, a second authz surface, and a join for four optional strings. The deny boundary is
preserved by `projectGuestVisibleFacts`'s allow-list, not by aggregate separation. Free-text fields carry a `maxLength`
(venue/dress 200, parking 500) to cap metered-send cost + payload smuggling to guests' phones; `couple_display_name`
gained a `maxLength 200` too — the last previously-unbounded term interpolated into a metered reply. Replies are built
from **trusted facts only** — never echoing the untrusted inbound text.

## Consequences

- A guest can now text for ceremony time / venue / parking / dress code and get a real metered answer; the detail page
  surfaces those facts when set.
- `refused` is emitted (and asserted) for surprise probes, wire-silently.
- The write path threads the four optional fields through JSON create/update with the established
  smuggle-proof reconstruction (identity from route, ownership from context, applied last).
- **Deferred:** a clear-to-absent update sentinel (omission preserves this rung); planner/couple HTML *forms* for these
  fields (JSON-only write this rung — a separate lever); modeling actual surprise content (which, if ever added, must be
  excluded at projection time and must keep the refuse outcome constant).
