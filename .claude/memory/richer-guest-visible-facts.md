---
name: richer-guest-visible-facts
description: "Phase 22: the guest-visible wedding-facts model grew to logistics (ceremony_time/venue_name/parking_info/dress_code) so the guest responder answers real questions, and the first `refused` fires — as a STATIC topic policy that reads no wedding data, NOT a stored-fact oracle. The projection allow-list is the security boundary; refuse is wire-silent."
metadata:
  node_type: memory
  type: project
---

**Phase 22** (the *usefulness* rung of [[guest-messaging-channel-is-a-roadmap-goal]]; both channel constraints already
done in Phases 18+20, so NO new channel safety machinery): the Phase-19 `DeterministicGuestQaResponder` could answer
exactly one question ("when is the wedding" — `event_date` was the only guest-visible fact). This rung grew the
**guest-visible fact model** to real logistics so a guest can text for **ceremony time / venue / parking / dress code**
and get a metered answer, and it lit up the `refused` action the vocabulary carried unused since Phase 19.

**THE LOAD-BEARING CORRECTION — `refused` is a STATIC topic policy, NOT a stored-fact oracle.** The handoff said "this
is where refused (surprise-classified facts) finally gets emitted." The non-obvious fix: refuse must **NOT** be
conditional on a per-wedding stored surprise fact. The adversarial gate `COMMS.SURPRISE_LEAK`
(`eval-harness/scenarios/adversarial/adversarial_surprise_leak_trap.yaml`) requires "must not reveal **OR EVEN
CONFIRM** the surprise exists." A refuse that fired only when *this* wedding has a surprise (escalate otherwise) would
let a guest learn a surprise exists **from the differing reply** — the exact existence oracle the surface denies. So
"surprise/secret" is a topic refused **unconditionally for every wedding, reading ZERO wedding data**: `respond` returns
a frozen module-level `REFUSED` constant from the surprise arm WITHOUT touching `facts` (fact-independence is
structural). **Consequence (deliberate): the wedding aggregate has NO surprise field** — no per-wedding surprise state
to project/branch/leak.

**THE PROJECTION IS THE SECURITY BOUNDARY; the keyword classifier is best-effort UX.** `projectGuestVisibleFacts` is an
explicit allow-list (`couple_display_name`, `event_date`, + the four optional logistics fields), never a spread — so
`tenant_id`/`status`/`wedding_id`/`created_at` and any future surprise field are STRUCTURALLY unreachable. The untrusted
text only SELECTS a topic (`classifyTopic`); it never gates readability (deny-by-fact-classification, never
deny-by-input-pattern). The classifier is necessarily incomplete (a surprise probe phrased without the keyword falls
through to a logistics/`unknown` topic) — **and that is safe precisely because the projection holds no surprise content
to leak.** Don't mistake the classifier for the control.

**`refused` is WIRE-SILENT this rung.** The inbound handler sends ONLY on `action==='answered'`; `escalated` and
`refused` both → uniform 202, no reply. A surprise probe is wire-indistinguishable from any unanswerable question (no
deflection text that could echo "surprise"). So the **handler needed NO change** — the richer responder just returns
more `answered` cases + a `refused` case. `refused` is the honest seam for a future "decline vs route-to-couple" split.

**Logistics disclosure split + the timing asymmetry (don't "harmonize" it away).** venue/parking/dress_code →
answer-if-present, else escalate (wire-silent) — safe because these are guest-shareable. **`timing` is asymmetric:**
`event_date` is schema-required so timing ALWAYS answers, and `ceremony_time` rides the answered-CONTENT channel
(appended only when set), NOT the escalate-when-absent path. Keep `event_date` non-optional in `GuestVisibleFacts` so
the timing branch needs no fallback.

**Smaller load-bearing facts.** Four fields are OPTIONAL + additive on the existing wedding aggregate (not a separate
facts aggregate) → every fixture still validates, **manifest count stays 18** (modifying a schema ≠ new schema; only
`gen:types` re-runs). Free-text fields carry `maxLength` (venue/dress 200, parking 500) + `couple_display_name` gained
`maxLength 200` — the last unbounded term in a metered reply (cost/smuggling cap). Replies are built from TRUSTED facts
only, never echoing the inbound text. The optional fields use a **conditional spread** (`...(x===undefined?{}:{x})`) in
create/update — NOT for `exactOptionalPropertyTypes` (that flag is OFF here; only `strict`), but because a literal
`k: undefined` would Ajv-reject the optional `type:string` AND pollute the projection's `Object.keys`. **Deferred:** a
clear-to-absent update sentinel (omission preserves); planner/couple HTML forms for these fields (JSON-only write this
rung); modeling actual surprise content (if ever added: exclude at projection, keep refuse constant). ADR 0022.
doddy APPROVE / architect APPROVE-WITH-FIXES (applied). 762 tests.
