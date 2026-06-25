# Phase 10 — Trusted `vision_match` + the `quality` North-Star component (the capstone)

## Why this, why now

`quality` is the single largest **unbuilt** value lever: weight **0.40** of `planning_value` (the largest
of the three numerator components), and it has been hard-`null` since Phase 1
(`metric_normalization.ts:40` — *"no LLM-judge rubric scores in Phase 1"*). Every other computed
North-Star input is now trusted-backed: `rsvp_resolution_rate` (4b), `guest_sentiment_score` (6),
`qa_accuracy_rate` (7), `category_completeness_rate` (8), and the couple-attention **cost** denominator
(4b/9). `quality` is the last gap in the "every computed North-Star input trusted-backed" arc.

`quality` rolls up rubric scores `vision_match`, `comms_quality`, `intuitiveness`
(`scoring_model.md:21`). Two of those three are genuinely judge-shaped (free-text comms tone, UX
intuitiveness) and have **no honest offline backing without an LLM judge** — building them would mean a
fabricated stub or a real Claude judge, both barred (offline-first; ADR 0007 judge→STOP). **`vision_match`
is different.** It is the alignment of a booked category's *selection* against the couple's *ground-truth
vision preference* — a deterministic, persona-grounded quantity, exactly the shape of
`category_completeness_rate` / `qa_accuracy_rate`. We can build it honestly with **no judge**, compute
`quality` as the mean of the *present* rubrics (just `vision_match` for now — the existing `meanOfPresent`
renormalization, `metric_normalization.ts:23`), and leave `comms_quality`/`intuitiveness` honestly absent.
This computes `quality` for the first time without fabricating a judge.

**Phase 9 built the exact degree of freedom this needs.** `scoring_model.md:80` names the Goodhart guard
*"couple_active_minutes ↓ → guard: vision_match — don't win by deciding badly-but-fast"* — that guard is
only meaningful once consulting the couple to raise selection quality **has a cost**. Phase 9 generalized
`couple_session` to a per-`(session_reason, about_id)` key precisely so new reasons can ride it at zero
incremental firewall cost. This phase adds the **4th reason `vision_consult`** (about_id = category_id):
the cost side is then *already firewalled* by Phase 9's `detectCoupleSessionDivergences` (composite key +
`active_seconds` field-diff). This phase adds only the **value side** (a new `vision_alignment` effect
kind) and the wiring of `quality`.

## The load-bearing insight (why `vision_match` is non-vacuous)

Same shape as Phases 7/8/9 — load-bearing **only** via the EXISTING tier-2 `autonomy_threshold`
(`canEscalate`/`canConsult`). A booked category that is **vision-sensitive** has a couple aesthetic
preference the planner can either align to (by consulting the couple — taking couple attention, the
tier-2 commitment_autonomy surface) or default on:

- A **tier-2** genome **consults** the couple on a vision-sensitive booked category → selection **aligned**
  → `honestVisionMatch = ALIGNED (1.0)`, AND **incurs a `vision_consult` couple session** (the cost).
- A **tier-1** genome **cannot consult** → it books with a **default** selection →
  `honestVisionMatch = DEFAULT (0.5)`, no consult session.
- A **non-vision-sensitive** category is aligned by default at no cost → **no vision claim at all** (its
  alignment is not graded), which is what keeps the search corpus byte-identical (below).

This is **INDEPENDENT of completeness**: the category is *booked either way* (vision-sensitivity is
orthogonal to `requires_couple_approval`). So `vision_match` is a genuine, orthogonal value axis on the
*same* booked categories — not a re-skin of completeness.

**Two forges this makes load-bearing:**
1. **Value side (the new surface).** A **tier-1** candidate that books a vision-sensitive category and
   **claims `vision_match_score = 1.0`** (aligned) it cannot honestly earn (honest `0.5`, it could not
   consult) → quality up for free. The trusted record (Stage B, re-derived from the same genome) holds the
   honest `0.5` → **field_mismatch** → veto. This is the NEW `vision_alignment` reconciliation.
2. **Cost side (rides Phase 9).** A **tier-2** candidate that honestly aligns (`vision_match = 1.0`) but
   **shaves/suppresses the `vision_consult` couple session** → same quality at sub-tier-2 cost → lower
   `effort_cost` → higher ratio. Caught by Phase 9's `detectCoupleSessionDivergences` on the
   `(vision_consult, category_id)` key (shave → field_mismatch on `active_seconds`; drop →
   suppressed_effect). The keystone proves both: `forgeWouldWinAbsentGate`, `onlyIntegrityFailed`.

The cleanest keystone is **tier-2 vs tier-2** for the cost forge (completeness AND vision both held — the
forge moves ONLY `effort_cost`) and **tier-1 vs tier-1** for the value forge (both defer the same, the
forge moves ONLY `vision_match` via a claimed-vs-honest score) — mirroring how Phase 8 isolated the
category rate and Phase 9 isolated `effort_cost`.

## The design: a new `vision_alignment` effect kind (value) + the `vision_consult` reason (cost)

One value surface, one cost reason, both keyed by `category_id`, both keystone-only by construction.

- **Ground truth** lives on the runtime `RequiredCategory` (Phase 8's plan-state type,
  `offline_scorer.ts:45`) as a new **optional** `vision_sensitive?: boolean` (defaults false). Like
  `requires_couple_approval`, it is runtime-only (NOT in any JSON Schema), so vision-bearing scenarios are
  **KEYSTONE-ONLY by construction** — they cannot leak into the YAML persona corpus the loader ingests, so
  the search cube/matrix pins are protected. Orthogonal to `requires_couple_approval` (a category can be
  approval-free yet vision-sensitive — the cleanest keystone shape).
- **Value metric** `vision_match_rate` = mean `vision_match_score` over the CLAIMED
  `category.vision.aligned` stream (claims with a valid `category_id`), null when none (the search corpus),
  mirroring `category_completeness_rate` exactly (claims-only denominator; the suppressed/forged arms guard
  the denominator via the integrity gate, not a `∪ should-have-aligned` term).
- **`quality`** in `metric_normalization.ts` becomes `meanOfPresent([get('vision_match_rate')])` — the
  present-rubric mean, naturally `null` on the search corpus (no vision claims) so the North Star
  renormalizes exactly as today. `comms_quality`/`intuitiveness` stay honestly absent (documented).
- **New event** `category.vision.aligned`, payload `{ category_id, vision_match_score }` — a SEPARATE event
  from `category.booked` so the completeness and quality pillars stay orthogonal (independent denominators,
  no overloaded payload). Fired only for `vision_sensitive && booked` categories.
- **New trusted record** `TrustedVisionAlignmentRecord { category_id, vision_match_score }`; recorder
  `recordVisionAlignment` / `visionAlignment(category_id)` / `allVisionAlignments()`.
- **New effect kind** `'vision_alignment'`; `detectVisionAlignmentDivergences` mirrors
  `detectCategoryBookingDivergences` ordering: missing `category_id` (forged) → duplicate-as-forge (2nd
  claim same `category_id`, before trusted lookup) → no-trusted (forged) → field_mismatch on
  `vision_match_score` (`skipWhenClaimAbsent:false`) → suppressed (trusted, no claim).
- **Shared honest facts** (`domain_facts.ts`): `ALIGNED_VISION_MATCH = 1`, `DEFAULT_VISION_MATCH = 0.5`;
  `honestVisionMatch(canConsult)` = `canConsult ? ALIGNED : DEFAULT`;
  `honestVisionConsultSession(canConsult)` = `canConsult`. Both stages call these on the same trusted
  genome → bit-identical → the exact field-diff never self-vetoes (the Phase-6 shared-computation
  argument). `canConsult === canEscalate` (`autonomy_threshold !== undefined`) — the SAME tier-2 surface.
- **Cost side** reuses Phase 9 wholesale: `CoupleSessionReason` gains `'vision_consult'`; Stage A/B emit
  one `couple.session.ended` (`session_reason:'vision_consult'`, `about_id:category_id`,
  `active_seconds:COUPLE_SESSION_ACTIVE_SECONDS`) per `honestVisionConsultSession`. NO new gate code —
  `detectCoupleSessionDivergences` already reconciles any reason via the composite key.

## Why this keeps every existing invariant

- **The search landscape is byte-identical.** Vision claims + `vision_consult` sessions fire ONLY when a
  `vision_sensitive` category is booked — and `vision_sensitive` (like `required_categories`) is absent
  from the search corpus. `quality` stays `null` there (no `vision_match_rate`) → `planning_value`
  renormalizes over the same two components as today → every search-corpus North-Star value, the pinned
  2-D matrix, and the 3-D cube are unchanged. Assert directly (zero vision claims + zero vision_consult
  sessions on the search corpus), mirroring Phase 8/9.
- **The Phase-8 category keystone is byte-identical.** Its `REQUIRED_CATEGORIES` carry no `vision_sensitive`
  flag → no vision events → its `category_completeness_rate`, `quality` (still null), and North Star are
  unchanged. Verify the existing keystone stays green untouched.
- **Orthogonal to completeness.** Vision events are a separate stream keyed independently; a booked
  category contributes to `category_completeness_rate` (via `category.booked`) AND, iff vision-sensitive,
  to `vision_match_rate` (via `category.vision.aligned`) — different denominators, no coupling.
- **Grader/numerator input, not a NEW veto-gate input.** `vision_match` feeds the North-Star *numerator*
  (`quality`); reconciling it extends the firewall (like 6/7/8) WITHOUT changing the integrity-gate
  *completeness* invariant ([[integrity-gate-completeness-invariants]], which concerns fields VETO gates
  read). Document so a future reader does not treat vision alignment as a veto-gate input.
- **No fabricated judge.** `vision_match` is a deterministic function of persona ground truth + trusted
  genome policy — NOT an LLM rubric. `comms_quality`/`intuitiveness` remain honestly `null` (their judge is
  STOP-and-surface, ADR 0007). `quality` is the honest mean of the one present rubric. The offline-first
  rail is intact; no API credentials, no stub-as-truth.

## Step 0 — design review (architect lens), DONE / findings folded

A `general-purpose` agent carrying the rigorous-architect lens reviewed this plan (the named specialists
are not provisioned here — handoff). **Verdict: APPROVE-WITH-CHANGES** — the core thesis (separate
`vision_alignment` effect kind + event; no-judge `vision_match`; load-bearing via the existing tier-2
surface; byte-identity by keystone-only `vision_sensitive`) is correct and faithful to the Phase 6–9
pattern. The separate-effect-kind call is confirmed *stronger* than stated: it keeps `vision_match_rate`'s
claims-only denominator INDEPENDENT of `category_completeness_rate`'s, so a duplicate/suppressed
`category.booked` can't perturb the Phase-8 keystone's "completeness is sole mover" isolation. The
load-bearing claim (Q4) and byte-identity (Q5) are confirmed real. Findings folded below:

1. **(P0) The duplicate/suppressed "vacuous defense-in-depth" framing was self-contradictory — RESOLVED by
   pinning the keystone corpus cardinality.** Under the 2-constant model, `honestVisionMatch` is UNIFORM
   per tier, so heterogeneity (the spread Phase-8's suppress/duplicate arms exploit) is unreachable at a
   fixed tier. The value-forge keystone is therefore a **single vision-sensitive category** (honest stream
   `{0.5}` at tier-1; claim `{1.0}` → rate 0.5→1.0 — the value forge HAS room on one element). On that
   single-element uniform stream, suppress (→ empty → null) and duplicate (→ `{0.5,0.5}` → still 0.5) genuinely
   CANNOT raise a claims-only mean — so they are correctly GATE-LEVEL firewall-completeness arms, NOT
   North-Star keystones, and Step 7 states exactly WHY (single-element uniform stream), not the prior loose
   "vacuous" claim. (Heterogeneous per-category vision difficulty — which WOULD make them load-bearing
   keystone arms like Phase 8 — is the deferred refinement in Out-of-scope.)
2. **(P1) The tier-2/tier-2 COST-forge scenario must have NO other mover of `couple_active_minutes_total`.**
   Tier-2 enables `rsvp_escalation` sessions (`escalationBudget`), so a cadence difference between champion
   and candidate could move couple cost via RSVP and OVER-DETERMINE the cost-forge arm. Pin the guest set to
   a SINGLE immediate responder, NOT couple-resolvable, no questions (as Phase 8 did) → zero pending
   couple-resolvable guests → cadence cannot create an RSVP escalation → `vision_consult` is the PROVABLY
   sole couple-cost contributor. Assert the honest companion's `couple_active_minutes_total` equals exactly
   one `vision_consult` session.
3. **(P1) The 0.40 `quality` weight rides a SINGLE rubric — document the leverage, assert direction+gate not
   magnitude.** `scoring_model.md:21` intends 0.40 to be the mean of THREE rubrics; with two absent,
   `vision_match` alone controls the full 0.40 block on a vision-bearing scenario (a 0.5→1.0 swing moves
   `planning_value` by 0.20). This is NOT a forge (the firewall still vetoes the lie) but it is leverage
   amplification + a thin-corpus caution (`scoring_model.md:104`). The keystone asserts the forge's
   DIRECTION (rate/ratio strictly up) and the GATE (`onlyIntegrityFailed`), never leans on the magnitude of
   the ratio delta. The ADR records that the 0.40 weight is provisional-while-thin and that this is an
   additional reason NOT to move vision scenarios into the search corpus (the over-weight would distort the
   optimizer gradient). Interaction with the accept rule is benign (quality is null on every search-corpus
   scenario; aggregate is per-scenario-then-weighted, no cross-scenario renormalization leak).
4. **(P1) Avoid the Phase-9 `active_seconds`-throw in scoring tests.** `readCoupleSessionEndedPayload`
   THROWS on absent/non-numeric `active_seconds` (uncaught by the metric engine). The cost forge is
   shave-then-suppress: **shave = present-but-lower** (no throw), **suppress = full-event-drop** (no event
   to read) — both safe. NEVER author an absent/non-numeric `active_seconds` on a present event in a
   full-scoring test. The NEW `readVisionAlignedPayload` is tolerant (null on out-of-range, mirroring
   `readCategoryBookedPayload`, NOT `requireNumber`) so the value-metric path has no throw — pin this.
5. **(P2) Reader-seam / wiring:** add `VISION_ALIGNED_REPORT_EVENT_NAMES` to `report_event_names.ts` (the
   shared report-event-name set — no reader seam) and import it into `integrity_gate.ts` alongside the
   others; wire `detectVisionAlignmentDivergences` into `detectSelfReportDivergence`'s list. Register
   `vision_match_rate: 'higher_better'` in `GUARD_DIRECTIONS` for catalog consistency, with the SAME
   inert-while-keystone-only caveat as `category_completeness_rate` (ADR-0008): an honest tier-1 candidate
   would guard-regress on vision_match vs an enthroned tier-2 champion, so it must NOT become an active
   search guard while vision is keystone-only. Feed `meanOfPresent` the explicit single-element
   `[get('vision_match_rate')]` (documents intent).
6. **(P2) Keep the multi-surface co-present self-veto guard** (Step 6c): a tier-2 category that is BOTH
   `requires_couple_approval` AND `vision_sensitive` emits `booking_approval/cat` AND `vision_consult/cat`
   couple sessions (DISTINCT composite keys, same `about_id`) — the only test proving the two reasons
   compose under Phase 9's key. Make it tier-2, assert zero divergences.

## Steps

- [x] **Step 0 — Architect-lens design review.** DONE — verdict APPROVE-WITH-CHANGES; all six findings
  (P0 corpus cardinality, P1 sole-cost-mover, P1 0.40-weight leverage, P1 active_seconds-throw, P2
  reader-seam/guard-direction, P2 multi-surface guard) folded into the Step 0 section + Steps 5/6/7/8 above.
- [x] **Step 1 — Value telemetry surface.** Add `EVENT_NAMES.category_vision_aligned =
  'category.vision.aligned'` and `METRIC_CODES.vision_match_rate`. Add `readVisionAlignedPayload` (fully
  tolerant like `readCategoryBookedPayload`: `{ category_id: string|null, vision_match_score: number|null }`,
  a non-numeric/out-of-range score → null) and the `visionMatchRate` metric function (mean of valid-score
  claims with a `category_id`; null when none) registered in `METRIC_DEFINITIONS`. Add `vision_consult` to
  the `CoupleSessionReason` vocabulary. Build green; unit-test the metric (mean, null-when-empty,
  id-less/invalid-score exclusion).
- [x] **Step 2 — Trusted record + recorder.** Add `TrustedVisionAlignmentRecord { category_id,
  vision_match_score }` + `recordVisionAlignment` / `visionAlignment(category_id)` / `allVisionAlignments()`
  on the recorder (mirror the category-booking recorder methods). Build + existing tests green.
- [x] **Step 3 — Shared honest facts** (extend `domain_facts.ts`, mirror `category_facts` tests). Add
  `ALIGNED_VISION_MATCH = 1`, `DEFAULT_VISION_MATCH = 0.5`, `honestVisionMatch(canConsult)` and
  `honestVisionConsultSession(canConsult)`. Test pins the load-bearing limitation: tier-1 (canConsult=false)
  → `DEFAULT` + no session; tier-2 → `ALIGNED` + session — so a refactor can't flatten it to vacuity.
- [x] **Step 4 — `RequiredCategory.vision_sensitive` + Stage A emit + Stage B record** (mirror the Phase-8
  category emission). Add optional `vision_sensitive?: boolean` to `RequiredCategory`
  (`offline_scorer.ts`). In Stage A: for each required category that is `vision_sensitive` AND honestly
  `booked`, emit one `category.vision.aligned` (`vision_match_score = honestVisionMatch(canEscalate)`) AND,
  iff `honestVisionConsultSession(canEscalate)`, one `couple.session.ended`
  (`session_reason:'vision_consult'`, `about_id:category_id`). Stage B records the matching trusted vision
  alignment + couple session via the SAME shared facts (bit-identical). Assert byte-identity: ZERO vision
  claims + ZERO vision_consult sessions on the vision-free search corpus AND on the Phase-8 category corpus.
- [x] **Step 5 — Integrity gate: `vision_alignment` reconciliation** (mirror
  `detectCategoryBookingDivergences`). Add `'vision_alignment'` to the `effect_kind` union; add
  `detectVisionAlignmentDivergences` (missing `category_id` → duplicate-as-forge → no-trusted forged →
  field_mismatch on `vision_match_score`, `skipWhenClaimAbsent:false` → suppressed) and wire it into
  `detectSelfReportDivergence`. Add a `VISION_ALIGNED_REPORT_EVENT_NAMES` set (and register the event name
  wherever the shared report-event-name set lives — no reader seam, per the completeness invariant).
  **doddy lens** review post-build: a claimed-high / duplicated / suppressed / phantom vision alignment
  cannot raise `vision_match_rate` while passing; the value and cost (`vision_consult`) surfaces compose
  without a bypass.
- [x] **Step 6 — Wire `quality` + honest-run audit + read-seam.** (a) `metric_normalization.ts`:
  `quality: meanOfPresent([get('vision_match_rate')])`; document that `comms_quality`/`intuitiveness` stay
  absent (judge→STOP). (b) Honest-run sweep over {vision-sensitive × tier-1/tier-2} reconciling clean
  (Stage A ≡ Stage B, zero divergences) — a stage divergence would self-veto every honest tier-2 vision run.
  (c) A multi-surface co-present scenario (a tier-2 category that is BOTH `requires_couple_approval` AND
  `vision_sensitive` → booking_approval session + vision_consult session + a `category.booked` + a
  `category.vision.aligned`, all reconciling clean) — guards that the completeness and quality surfaces, and
  the two couple-session reasons, compose. (d) Read-seam: the `vision_match_rate` metric reader and the
  integrity gate reader agree on an honest vision-bearing stream.
- [ ] **Step 7 — Forge keystone(s) (full North-Star).** `loop-orchestrator/tests/loop/
  vision_match_forge_keystone.test.ts`, mirroring `category_forge_keystone.test.ts`. **Corpus is pinned:
  a SINGLE approval-free, vision-sensitive category + a SINGLE immediate-responder guest (not
  couple-resolvable, no questions)** — so vision_match is the sole value mover and `vision_consult` is the
  provably-sole `couple_active_minutes_total` mover (no cadence-driven RSVP escalation, P1 findings 2+4):
  - **Value forge (tier-1 vs tier-1, liar targets cadence-2 candidate):** honest `vision_match 0.5` each
    (single-element claimed stream). Candidate claims `vision_match_score 1.0` → `vision_match_rate` 0.5→1.0
    → `quality` up → ratio strictly up; `forgeWouldWinAbsentGate(r)===true`, `onlyIntegrityFailed(r)===true`
    (claimed 1.0 ≠ trusted 0.5 → field_mismatch), `accepted===false`. Assert DIRECTION + gate, never the
    ratio-delta magnitude (the 0.40 single-rubric leverage, P1 finding 3).
  - **Cost forge (tier-2 vs tier-2, liar targets cadence-2 candidate):** both book + align (vision 1.0
    each, identical completeness AND quality); the honest companion's `couple_active_minutes_total` ==
    exactly one `vision_consult` session (assert it — proves sole mover). Candidate **SHAVES** (present-but-
    lower `active_seconds`, near-miss 599 vs 600) then in a second arm **SUPPRESSES** (full-event-drop) its
    `vision_consult` session → `couple_active_minutes_total` strictly down → `effort_cost` down → ratio up;
    same three counterfactual asserts. NEVER author an absent/non-numeric `active_seconds` (Phase-9 throw).
  - **Honest companion** gate-clean (`new_gate_failures === []`, ties the champion, not accepted).
  Add the firewall-completeness gate-level arms (duplicate / suppressed / phantom vision claim →
  forged/suppressed) as direct `detectSelfReportDivergence` assertions in a GATE test — NOT North-Star
  keystones, because on the single-element uniform claimed stream they cannot raise a claims-only mean
  (suppress→empty→null, duplicate→`{0.5,0.5}`→0.5); state this reason explicitly (P0 finding 1).
  **testineer lens** review; add any missing near-miss/arm it flags.
- [ ] **Step 8 — ADR 0010 + memory + handoff.** ADR documenting: the `vision_match` value surface, the
  no-judge honesty argument (deterministic persona-grounded quantity; `quality = meanOfPresent` over present
  rubrics; comms/intuitiveness still STOP), the orthogonal-to-completeness independence, the cost side
  riding Phase 9's `vision_consult` reason, and the keystone decomposition. Note the "every computed
  North-Star input trusted-backed" arc is now COMPLETE. Memory `[[vision-match-trusted-reconciliation]]`
  (or extend an existing) indexed in `MEMORY.md`; register guard-direction constants if any; update
  `.claude/handoff.local.md` (capstone done; next levers = comms/intuitiveness judges are STOP-gated, OR
  move category/vision scenarios into the search corpus, OR a 4th tier-1 knob).

## Verification (every step)

`npm run build` (standalone from the REPO ROOT, check `$?` — never pipe to tail/grep, it masks the exit),
then `npm test`, then `npm run lint`. All green before ticking a box or committing. Commit per verified step
on `build/phase-3-generalize-search`.

## Out of scope (recorded, not faked)

- **`comms_quality` / `intuitiveness` rubrics** — genuinely judge-shaped (free-text tone, UX); honest
  offline backing needs a real Claude judge → STOP-and-surface (ADR 0007). They stay `null`; `quality` is
  the honest present-rubric mean. NOT faked here.
- **Per-category heterogeneous vision difficulty / continuous alignment** — a richer model (a category's
  vision_match a graded function of selection vs preference, enabling denominator-spread forges at the
  keystone level) is a scenario-authoring refinement, not a forge surface. Start with the
  `ALIGNED`/`DEFAULT` two-constant model (Phase 8/9 "start with one constant" discipline); the gate arms are
  built for heterogeneity, the keystone proves the load-bearing field_mismatch + cost forges.
- **Moving vision/category scenarios INTO the search corpus** — now even more *possible* (quality is the
  consult payoff, the cost is modeled), but a separate decision with its own guard/spread analysis;
  keystone-only stays the default invariant.
