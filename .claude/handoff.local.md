# Handoff

## Where things stand — Phase 22 (richer guest-visible facts + the first `refused`) is COMPLETE ✅
`.claude/plans/2026-06-27-phase-22-richer-guest-visible-facts.md` is **complete — Step 0 design review + Steps 1–5
ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3–22 build on
it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**762 tests**, up from 749 at the start of this run).

This rung makes the now-operable guest-messaging channel ([[guest-messaging-channel-is-a-roadmap-goal]]) actually
*useful*: the Phase-19 responder could answer only "when is the wedding"; now a guest can text for **ceremony time /
venue / parking / dress code** and get a metered answer, and the `refused` action finally fires (for surprise probes).
ADR 0022, memory [[richer-guest-visible-facts]]. doddy APPROVE / architect APPROVE-WITH-FIXES on design AND built code
(all fixes applied). Verified end-to-end against the inbound edge (logistics question → one metered reply; surprise
probe → wire-silent 202, no send).

## What changed this phase
- **Wedding schema** gained four OPTIONAL logistics fields (`ceremony_time` HH:MM, `venue_name`, `parking_info`,
  `dress_code`) — additive (every fixture still validates), so the **manifest count stays 18** (gen:types re-ran).
  Free-text fields carry `maxLength`; `couple_display_name` gained `maxLength 200` (last uncapped metered-reply term).
- **Write surface** — `CreateWeddingInput` + `WeddingRepository.create` + JSON `handleCreate`/`handleUpdate` thread the
  four optional fields through (conditional-spread; identity/ownership still applied LAST). Detail page surfaces them.
- **`DeterministicGuestQaResponder`** rewritten: `classifyTopic` (TOPIC_PATTERNS, first-match priority — surprise first,
  parking before venue) → answer logistics if present / escalate if absent / **refuse surprise**. `GuestVisibleFacts`
  grew to the explicit logistics allow-list. Inbound handler UNCHANGED (sends only on `answered`).

## The load-bearing insight (carry forward) — see [[richer-guest-visible-facts]] for the full set
- **`refused` is a STATIC topic policy reading ZERO wedding data** (frozen `REFUSED` constant returned WITHOUT touching
  `facts`), NOT conditional on a stored surprise fact — a conditional refuse is the exact surprise-existence oracle
  `COMMS.SURPRISE_LEAK` forbids ("even confirm"). So the wedding has **NO surprise field**.
- **The PROJECTION allow-list is the security boundary**, not the classifier. A misclassified surprise probe leaks
  nothing because the projection holds no surprise content. The classifier is best-effort UX.
- **`refused` is wire-silent** (refused/escalated both → uniform 202, no send) so the handler needed no change.
- **Timing asymmetry:** `event_date` required → timing always answers; `ceremony_time` rides the answered-content
  channel; venue/parking/dress answer-if-present-else-escalate. Don't "harmonize" timing into the escalate path.
- **Conditional-spread (`...(x===undefined?{}:{x})`)** is for the RUNTIME (Ajv rejects `k:undefined` for the optional
  `type:string` + it pollutes `Object.keys`), NOT `exactOptionalPropertyTypes` (that flag is OFF here; only `strict`).

## Next action — your call. Pick the next high-value lever (ranked)
- **★ Couples managing their own wedding's guests** — extend `GuestAuthorizer` (today planner-only, no resource
  decision) to a couple-scoped resource decision (a couple manages only their bound wedding's guests). The Phase-21
  tripwire; smaller, folds naturally onto the guest CRUD surface. **Recommended.**
- **★ Planner/couple HTML wedding create/edit forms** (incl. the new logistics fields) — the `CsrfGuard` seam from
  Phase 21 already exists; today weddings + their logistics are JSON-only over the browser. Natural next browser
  mutation; makes the logistics demoable end-to-end via the UI (a planner sets the dress code, a guest texts and gets it).
- **A clear-to-absent update sentinel** for logistics fields (omission currently preserves; no way to unset). Small,
  product-completeness; pairs well with the HTML edit forms above.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`) — the
  clean follow-up Phase 20 deferred; tidies the two-cents-tables seam.
- **A "decline vs route-to-couple" escalation/notification model** — gives `escalated` (and the now-distinct `refused`)
  real downstream behavior (notify the couple when a guest asks an unanswerable logistics question). Larger.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging provider
sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line, never across it or
simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The named
specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route adversarial reviews
through `general-purpose` agents carrying the persona lens (this run did, at design AND on the built code — doddy
APPROVE, architect APPROVE-WITH-FIXES, all fixes applied). **CI/exit-code lesson:** never pipe `npm run build` to
tail/grep when gating with `&&` (the pipe masks the non-zero exit); run build standalone, check `$?`. `npm run build`
runs from REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by
reachability — types are erased, so a schema-generated type flowing to shared is fine). **Schema change ⇒ `npm run
gen:types`**; a NEW schema file additionally bumps the manifest count test + the gen-script header (modifying an
existing schema does NOT). **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list** — any
new guest-visible fact is added THERE; a surprise/PII fact must never enter it, and `refused` must stay fact-independent.
