# Phase 22 — A richer guest-visible wedding-facts model (logistics answers + the first `refused`)

**Status:** COMPLETE — all steps ticked (762 tests green; doddy APPROVE / architect APPROVE-WITH-FIXES on design AND built code, fixes applied). ADR 0022, memory [[richer-guest-visible-facts]].
**Branch:** `build/phase-3-generalize-search` (the open review artifact for `main`; Phases 3–21 build on it; this continues it)
**Predecessor:** Phase 21 (planner guest-management CRUD + the first browser-form CSRF) — complete, 749 tests green.

## Goal

Make the now-operable guest-messaging channel ([[guest-messaging-channel-is-a-roadmap-goal]]) actually *useful*: today the
Phase-19 `DeterministicGuestQaResponder` can answer exactly **one** question — "when is the wedding" (the only
guest-visible fact is `event_date`). Every other guest text escalates. This rung grows the **guest-visible fact model**
to real logistics — **ceremony time / venue / parking / dress code** — so a guest who texts "what's the dress code?"
gets a real answer through the metered reply path, and it lights up the `refused` action that the responder vocabulary
has carried (unused) since Phase 19.

Deliverables, end-to-end and offline:
- **Schema:** four new **optional** logistics fields on the `wedding` aggregate (`ceremony_time`, `venue_name`,
  `parking_info`, `dress_code`) — additive, so every existing wedding/fixture still validates. `npm run gen:types`.
- **Write surface:** the JSON wedding create/update path (`POST` / `PUT /t/:slug/weddings`) accepts the new optional
  fields (planner + owning-couple, the existing authz); the read-only themed detail page (`?wedding=<id>`) surfaces
  them when present. (HTML create/edit *forms* stay a separate deferred lever — JSON write only here.)
- **Responder:** a deterministic topic classifier over the guest-visible projection that answers each logistics fact
  when present, **escalates** when a logistics fact is unset, and **refuses** a surprise/secret probe.

## The hard rails (unchanged — CLAUDE.md)

Offline-first. No real money / booking / comms. The product surface **imports only `@wedding-planner/shared`, never
loop/eval** (firewall by reachability; the graph stays acyclic — this rung touches only `product/` + the
schema-generated `Wedding` type, which is erased at runtime, so the firewall is untouched). Injected clock/ids (no
ambient time/RNG). One safety model — reuse it, never invent a parallel one. Don't modify `ops/` or `CLAUDE.md`. Push
only to `origin`. **Schema change ⇒ `npm run gen:types`** (modifying an existing schema does NOT change the manifest
count — still 18 — so no count-test bump; only the generated `wedding.ts` type regenerates). `npm run build && npm
test && npm run lint` green before every tick/commit; build standalone (never piped — a pipe masks the non-zero exit),
check `$?`. Commit per verified step on the `build/*` branch.

## The safety crux — `refused` MUST be a STATIC topic policy, never a stored-fact oracle (design it once, here)

The handoff framed this rung as "where `refused` (surprise-classified facts) finally gets emitted." The **non-obvious
correction**, load-bearing for safety: `refused` must **NOT** be conditional on a per-wedding stored surprise fact.

**Why a conditional refuse would be a forbidden oracle.** The adversarial contract is explicit
(`eval-harness/scenarios/adversarial/adversarial_surprise_leak_trap.yaml`, gate `COMMS.SURPRISE_LEAK`): the AI *"must
not reveal **or even confirm** the surprise exists to guests."* If the responder said "I can't share that" only when
*this* wedding has a surprise on record, and escalated otherwise, the guest would learn — from the **difference in
reply** — that a surprise exists. That is exactly the existence oracle the whole product surface is built to deny, and
it directly violates the gate. It is also `deny-by-input-pattern` masquerading as classification (the responder doc's
P2 boundary: *"deny-by-fact-classification, NEVER deny-by-input-pattern"*).

**The correct design — refuse on a static, wedding-independent TOPIC classification.** "Surprise / secret" is a
**topic** the platform refuses **unconditionally**, for **every** wedding, reading **no** wedding data. The untrusted
text only **selects** the topic (the existing deny-by-fact-classification rule: the text selects among an already-safe
decision set; it never gates readability). Because the refuse outcome reads zero per-wedding state and is **byte-identical
for every wedding and guest**, it can leak nothing — it is not a per-wedding surprise oracle. The platform policy "we
don't field surprise questions here" is public and constant; *whether a given couple has a surprise* is never touched.

**Consequence (deliberate, this rung):** the wedding aggregate gets **NO surprise field**. There is no surprise content
to store, project, or leak; refuse is pure static policy. (A future rung that *does* model surprise content must
exclude it at `projectGuestVisibleFacts` time AND keep the refuse outcome constant — never branch the guest-visible
behavior on it.)

**`refused` is internal-only at the wire this rung (strongest no-confirm posture).** The inbound handler already sends
**only** on `action === 'answered'`; `escalated` and `refused` both produce the uniform `202` with **no reply**. So a
surprise probe is wire-**indistinguishable** from any other unanswerable question — no deflection text that could echo
"surprise" and softly confirm it. `refused` is a real, asserted classification (returned by the responder, exercised in
tests) and the honest seam for a future "decline vs route-to-couple" divergence; it just carries no guest-visible reply
yet. The handler therefore needs **no change** — only new test coverage over the richer responder.

**The logistics "answer-if-present / escalate-if-absent" split is safe** because ceremony time / venue / parking / dress
code are **guest-shareable by definition** — leaking "the couple hasn't set a dress code yet" (escalate) vs the value
(answer) discloses only non-sensitive logistics state, which is the point of the channel. The sensitive class
(surprises) never rides this split; it is the constant-refuse policy that reads nothing.

## Steps

### Step 0 — Design review (doddy + architect lens), before code
- [x] Routed the design through doddy-lens + architect-lens `general-purpose` agents (named sub-agents not provisioned).
      Both **APPROVE-WITH-FIXES**; the two load-bearing claims hold (static-topic refuse is genuinely non-oracle; the
      wire collapses `refused`≡`escalated` into the uniform 202, satisfying `COMMS.SURPRISE_LEAK`'s "even confirm").
      **Must-fixes folded into the steps below:**
  - **(F1) The PROJECTION is the security boundary; the surprise-refuse is UX courtesy.** The keyword classifier is
    necessarily incomplete (a surprise probe phrased without "surprise"/"secret" falls through to a logistics/`unknown`
    topic) — that is SAFE *only* because `GuestVisibleFacts` contains zero surprise-classified content, so a
    misclassified probe can answer/escalate but never leak a surprise. Pin this where it can fail: a test asserting the
    projection's keys are EXACTLY the allow-list, and the responder header must state the real control is the projection.
  - **(F2) Make the refuse outcome's fact-independence STRUCTURAL.** Route surprise through a frozen module-level
    constant `REFUSED` outcome returned WITHOUT reference to `facts`; assert referential identity in the no-oracle test
    (so "reads no wedding data" is enforced by the code, not by convention a future edit could break).
  - **(F3) Replies are built from TRUSTED facts ONLY — never echo the untrusted inbound `text`.** `escalated`/`refused`
    carry NO `reply_text`; `answered` interpolates only projected fact values. (The detail page already escapes via `html`.)
  - **(F4) Pin the priority order with a co-occurrence test:** "is there a surprise at the venue?" (surprise + a
    logistics keyword in one message) → `refused`, not `venue`.
  - **(F5) `exactOptionalPropertyTypes`: use the SPREAD-assignment form** (`...(v === undefined ? {} : { k: v })`) in
    BOTH `WeddingRepository.create` AND `handleCreate`'s `CreateWeddingInput` build — NOT `k: optionalString(...)`
    (which types `string | undefined` and fails the optional-prop assignment). `handleUpdate`'s ternary is already fine.
  - **(F6) Document the timing asymmetry:** `ceremony_time` rides the *answered-content* channel (the timing reply
    always sends; its body varies on ceremony_time presence) — UNLIKE venue/parking/dress_code which escalate-when-absent.
    Both are guest-shareable so both are safe; the asymmetry must be written down so a future "harmonization" can't
    turn it into an oracle. Keep `event_date` NON-optional in `GuestVisibleFacts` so the timing branch needs no fallback.
  - **(F7) Schema hardening:** add a `maxLength` to each free-text field (caps metered-send cost amplification +
    payload smuggling to guests' phones): `venue_name`/`dress_code` 200, `parking_info` 500.
  - **(F8) Malformed-input coverage:** extend the Step-2 negative test to a `null` and a numeric value for one new
    field (confirm `requireString` throws → VALIDATION_FAILED → 400; `body.X === undefined` does NOT swallow `null`).

### Step 1 — Schema: four optional logistics fields + regenerate the type
- [x] `product/schemas/wedding_schema.json`: add (optional, NOT in `required`, `additionalProperties` stays `false`):
      `ceremony_time` (string, `pattern ^([01][0-9]|2[0-3]):[0-5][0-9]$` — 24h `HH:MM`), `venue_name` (string,
      `minLength 1`), `parking_info` (string, `minLength 1`), `dress_code` (string, `minLength 1`). Each with a clear
      `description` (guest-visible logistics; no surprise/PII fields here — that is the deny-by-classification boundary).
- [x] `npm run gen:types`; confirm `shared/src/contracts/generated/wedding.ts` gains the four optional fields.
- [x] Verify the manifest count test (`shared/tests/contracts/schema_registry.test.ts`) still passes unchanged (18 —
      no new schema file). Build/test/lint green. Commit.

### Step 2 — Write surface: repo + JSON create/update carry the optional fields
- [x] `product/src/wedding/wedding_repository.ts`: `CreateWeddingInput` gains the four optional fields; `create` copies
      each through **only when present** (the `...(x === undefined ? {} : { x })` spread, honoring
      `exactOptionalPropertyTypes`). `update` already round-trips the whole record — no change beyond the type flowing.
- [x] `product/src/http/product_api.ts`: `handleCreate` reads each via `optionalString(body, …)`; `handleUpdate`
      threads each as `body.X === undefined ? existing.X : requireString(body, 'X')`, applied with identity/ownership
      LAST (the existing smuggle-proof reconstruction). Bad values fail the contract → `VALIDATION_FAILED` → 400.
- [x] Tests: repo create/update with/without each field; JSON `POST`/`PUT` round-trip; a malformed `ceremony_time`
      (e.g. `"25:00"`) → 400. Build/test/lint green. Commit.

### Step 3 — Responder: topic classifier (answer logistics / escalate-absent / refuse surprise)
- [x] `product/src/messaging/guest_qa_responder.ts`:
  - Grow `GuestVisibleFacts` to the **explicit allow-list**: `couple_display_name`, `event_date`, and optional
    `ceremony_time` / `venue_name` / `parking_info` / `dress_code`. `projectGuestVisibleFacts` copies exactly these
    (still NO spread; status/created_at/tenant_id/wedding_id and any future surprise field structurally unreachable).
  - Add an internal `classifyTopic(text): 'surprise' | 'parking' | 'dress_code' | 'timing' | 'venue' | 'unknown'`
    — first-match in **that priority order** (surprise first so any surprise/secret mention refuses regardless;
    parking before venue so "where do I park" is parking, not venue).
  - `DeterministicGuestQaResponder.respond`: `surprise → { action: 'refused' }` (reads no facts); `timing → answered`
    (`event_date`, appending ` at ${ceremony_time}` when present — `event_date` is always present so timing always
    answers); `venue|parking|dress_code → answered` when the fact is present, else `escalated`; `unknown → escalated`.
  - Rewrite the file header: replace the "trivial projection, refused never needed" note with the static-topic-refuse
    reasoning from the safety crux above.
- [x] Tests (`product/tests/messaging/guest_qa_responder.test.ts`): each topic answered when present; each logistics
      topic **escalated** when absent; **surprise/secret probe → `refused`** and the outcome is **identical regardless
      of any wedding data** (the no-oracle property — assert the same `refused` for two weddings differing in every
      field); the projection excludes non-allow-listed fields (assert keys). Build/test/lint green. Commit.

### Step 4 — End-to-end inbound + detail page
- [x] Inbound integration test (`product/tests/http/…` alongside the Phase-19 inbound tests): a guest bound to a wedding
      texts "what's the dress code?" with a dress code set → exactly one metered `send` with the fact reply, uniform
      202; the same guest texts "what's the surprise?" → **no send**, uniform 202 (refuse is wire-silent). Confirm the
      inbound handler needed no change (assert via behavior).
- [x] `product/src/web/pages.ts` `renderDetail`: surface `ceremony_time` / `venue_name` / `parking_info` / `dress_code`
      when present (each through the `html` escaping template; omit the row when unset). A render test. Build/test/lint
      green. Commit.

### Step 5 — Built-code review, ADR, memory, handoff
- [x] Route the BUILT code through the doddy + architect lens agents; apply findings.
- [x] `docs/adr/0022-richer-guest-visible-facts.md` — the static-topic-refuse decision + the no-surprise-field
      consequence + the logistics disclosure rationale.
- [x] Memory `.claude/memory/richer-guest-visible-facts.md` (+ index in `MEMORY.md`) — the load-bearing correction
      (refuse is static-topic policy, NOT a stored-fact oracle; "even confirm" is the gate; no surprise field this rung).
- [x] Update `.claude/handoff.local.md`. Final green. Commit.

## Done when
All boxes ticked; `npm run build && npm test && npm run lint` green; doddy+architect lenses APPROVE design AND built
code; ADR 0022 + memory committed; handoff updated. A guest can text for ceremony time / venue / parking / dress code
and get a real metered answer; a surprise probe refuses wire-silently with zero per-wedding disclosure.
