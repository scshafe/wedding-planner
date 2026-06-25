# Phase 8 — Plan-state model + trusted `category_completeness_rate` (complete the completeness trilogy)

## Why this, why now

`completeness` (North-Star numerator, weight 0.35) is the mean of three value-metrics
(`metric_normalization.ts:41-45`): `rsvp_resolution_rate` (trusted-backed, Phase 4b), `qa_accuracy_rate`
(trusted-backed, Phase 7), and **`category_completeness_rate`** — named in the catalog, wired into the
completeness mean, with a reserved metric code (`telemetry_constants.ts:75`) and a reserved event name
(`category.booked`, `telemetry_constants.ts:24`), but with **no metric function, no simulator model, and
no trusted backing**. It is the LAST claimed-only completeness metric. Closing it **completes the
completeness trilogy** (all three completeness inputs trusted-backed).

It is also the **FIRST plan-side model** in the whole system. Every phase so far (RSVP, sentiment, Q&A)
modeled GUEST interactions. None modeled the PLAN itself — which categories the couple needs and which
the planner actually books. This is the substrate a future `quality` phase needs (vision-match scores a
booked plan), so it is foundational, not just incremental.

`quality` (the only larger lever, weight 0.4) stays honestly deferred: a real Claude judge needs API
credentials → the offline-first STOP rail; a deterministic stub adds an unbacked claimed-only forge
surface → the fabrication rail. ADR 0007 records that deferral; this phase does not touch it.

## The load-bearing insight (why a naïve booking model would be VACUOUS)

For the integrity firewall to be **load-bearing**, the trusted record (Stage B) must be able to
*disagree* with a forged claim **in a way the metric rewards** — there must be a genome-dependent honest
gap to forge UP. A naïve model where the honest planner books **every** required category is **vacuous**:
honest `category_completeness_rate` is pinned at 1.0 and the only divergent claims a liar can make lower
its own metric. Nothing to forge up. (Exactly the Phase-7 vacuity trap.)

**The fix (no new search knob): booking competence is genome-dependent via the EXISTING tier-2
`autonomy_threshold` knob — the SAME `commitment_autonomy` surface Q&A escalation uses.** A required
category carries a ground-truth `requires_couple_approval` flag. Securing the couple's sign-off on a
high-commitment booking (venue, catering) **consumes couple commitment-authority** — precisely the
tier-2 surface (`risk_tier.ts`). So:

- A `requires_couple_approval` category is booked correctly **only by a genome that can escalate**
  (carries `autonomy_threshold`, tier-2). The honest tier-2 planner books it (`booking_status='booked'`).
- A **tier-1** genome (no `autonomy_threshold`, the canonical search form) **cannot secure approval** →
  its honest outcome on that category is **`booking_status='deferred'`** (it cannot autonomously commit
  the couple to a major booking) → `category_completeness_rate < 1.0`.
- A category with `requires_couple_approval=false` is booked at any tier (correct) — tier-independent.

Encoded as the SHARED fact `honestCategoryStatus(requiresCoupleApproval, canEscalate)` in
`domain_facts.ts` (both stages compute it bit-identically), mirroring `honestQaAction`. `canEscalate` is
derived from the TRUSTED genome (`autonomy_threshold !== undefined`) on both sides, so honest runs never
self-veto.

**The forge this makes load-bearing:** a **tier-1** candidate that **claims it booked** a
`requires_couple_approval` category (claimed `booking_status='booked'` → `category_completeness_rate` up)
**without** the couple commitment cost — tier-2-grade completeness for free. The trusted record (Stage B,
re-derived from the tier-1 genome) says the honest status was `deferred`, so claimed `booked` ≠ trusted
`deferred` → **field_mismatch → veto**. Absent the gate this strictly dominates a tier-2 champion (same
completeness, no cost); with the gate it is rejected. That is the keystone.

## Why this keeps every existing invariant

- **The search landscape is untouched.** `category_completeness_rate` returns `null` when a couple has no
  `required_categories` (zero denominator), and the entire search/oracle corpus is category-free. So the
  pinned 2-D matrix / 3-D cube in `metamorphic_oracle.test.ts` and all existing North-Star values are
  **byte-identical**. Honest category scoring enters ONLY in category-bearing corpora (the new keystone).
- **INVARIANT (mirror of Phase-7's): category-bearing scenarios are KEYSTONE-ONLY — never in the
  autonomous search corpus.** Because booking correctness on `requires_couple_approval` categories is
  tier-gated, an honest tier-1 search candidate scored on a category-bearing scenario against an enthroned
  tier-2 champion would *guard-regress* on `category_completeness_rate` if it were a registered guard.
  Keep category-bearing couples out of the search corpus (they live only in the keystone). Record in
  memory. (Confirm whether `category_completeness_rate` should be a guard at all — mirror exactly the
  Phase-7 treatment of `qa_accuracy_rate` in `scoring_constants.ts`.)
- **The tier-1 search box stays tier-1 and forge-free.** Category completeness is null in the box; correct
  booking of a `requires_couple_approval` category *requires* tier-2, which the promotion gate already
  PARKS ([[tier2-promotion-gate-is-load-bearing]]). The autonomous tier-1 search can never legitimately
  lift it — an honest limitation, not a forge.
- **Grader-input, not veto-gate-input.** Like sentiment (Phase 6) and Q&A (Phase 7), this extends the
  firewall to a North-Star *numerator* input; it does NOT change the integrity-gate completeness invariant
  ([[integrity-gate-completeness-invariants]], which concerns fields *veto gates* read). Document so a
  future reader does not conclude category bookings must become a gate input.

## The model (TWO reconciliation surfaces: a join key + one numerator field)

Mirror the Q&A pattern, transposed from a per-(guest,question) key to a per-required-category key. The
reconciliation has **two surfaces**, exactly as Q&A's denominator/numerator are each defended:

- **Claim event** `category.booked` (the reserved event name): one per required category, payload
  `{ category_id, category, booking_status }` where `booking_status ∈ {'booked','deferred'}`. The honest
  planner emits one per required category — `booked` if `honestCategoryStatus` says so, else `deferred`.
- **Metric** `category_completeness_rate` (CLAIMS-ONLY, like the other rates): numerator = claims with
  `booking_status === 'booked'`; denominator = claims with a valid `category_id`; `null` when zero. A
  claim with a missing/invalid status counts as incorrect (conservative; the gate vetoes it separately).
  The metric reads EXACTLY `{category_id, booking_status}` — it does NOT read `requires_couple_approval`.
- **Trusted record** `TrustedCategoryBookingRecord { category_id, category, booking_status }`, one per
  required category, keyed by `category_id`. `requires_couple_approval` is the trusted-INTERNAL driver of
  the honest status; it is never a claimed field and the metric never reads it, so there is NO relabel
  surface (this is why Q&A needed two fields — its metric reads `answerable_by_expected` via
  `requiredQaAction` — and category needs only one). The general invariant still holds: the gate diffs
  every field the metric reads.
- **Integrity gate, 7th effect kind `category_booking`** (mirror `detectQaDivergences`) — the two surfaces:
  - **`category_id` (join key) defends the DENOMINATOR**, via three arms mirroring Q&A's per-question
    triad: forged (a claim for a `category_id` with no trusted record), forged-on-DUPLICATE (a 2nd claim
    for an already-claimed `category_id` — a per-category rate is gamed by re-emitting a `booked` claim to
    dilute deferred ones, so the 2nd claim is a forge, checked BEFORE the trusted lookup), and suppressed
    (a trusted required category with no claim — dropping a `deferred` category would otherwise raise the
    claims-only rate). These three arms are NOT redundant with the single field diff — they are the
    denominator defense and must all be built.
  - **`booking_status` defends the NUMERATOR**, via field_mismatch (`skipWhenClaimAbsent:false` — an
    absent/invalid status against a trusted value is a veto, not a skip).

**Deferred (consistent with the existing codebase):** Phase 8 does NOT model a couple-attention COST for
securing booking approval — exactly as Phase 7 does not yet charge a cost for Q&A escalation (the
"QA-escalation couple cost" the Phase-7 handoff lists as future hardening). A tier-2 genome books
approval-required categories "for free" in this model; that is acceptable because such genomes are PARKED
by the promotion gate and category-bearing scenarios are keystone-only. The keystone proves the FORGE is
vetoed; modelling the cost is a clean follow-on (would let a single keystone exercise both the
completeness lift and its commitment cost). Note it in the ADR + handoff.

## Where the ground truth lives (architect P1-A: runtime ScenarioDefinition, NOT the couple JSON schema)

Add an **optional** `required_categories` array to the eval-harness **runtime `ScenarioDefinition`**
(`offline_scorer.ts:35-42`) — the SAME home as `bookedPlanFacts`, the existing plan-side ground-truth
fact that is deliberately runtime-only and NOT in any JSON Schema. This is the correct precedent (not
`guest_persona.questions`): `questions` are consumed by an LLM role-player + graders, whereas
`required_categories` is a plan-state simulator/grader fact with no role-player — exactly `bookedPlanFacts`'s
profile. Entry shape `{ category_id: string; category: VendorCategory; requires_couple_approval: boolean }`,
reusing the EXISTING generated `category` union via a shared type alias (do NOT re-inline the enum a third
time). Stage A/B read `scenario.required_categories ?? []`.

Benefits over the schema route: zero `npm run gen:types` blast radius (no rewrite of the shared
`couple_persona.ts` every module imports, no third copy of the category enum); and the keystone-only
invariant becomes **structural** — a runtime-only field cannot leak into the YAML persona corpus the
loader ingests, so the cube/matrix pins are protected by construction, not by discipline.

---

## Steps (green — `npm run build && npm test && npm run lint` — before ticking each)

- [x] **Step 0 — Design review (rigorous-architect lens).** DONE — verdict **APPROVE-WITH-CHANGES**, no
  P0s. The core thesis (tier-2-gated booking competence as the genome-dependence lever; join-key +
  single-numerator-field reconciliation; keystone-only category scenarios) is sound and non-vacuous. Folded
  in all findings above: **P1-A** moved `required_categories` to the runtime `ScenarioDefinition` (mirrors
  `bookedPlanFacts`, no contract regen, structural keystone-only); **P1-B** explicit `metric_catalog`
  reconciliation; **P1-C** named the two reconciliation surfaces (join key defends denominator, status
  defends numerator, approval flag unread→undiffed); **P2-A** keystone needs co-present booked+deferred
  categories; **P2-B** no oracle module, only the status union; **P2-C/E** ADR ties deferred-cost to the
  keystone-only invariant + register the guard direction without activating it; **P2-D** assert byte-identity
  directly.

- [x] **Step 1 — Shared status vocabulary + honest fact (NO oracle module — P2-B).** Add ONLY the
  `CategoryBookingStatus = 'booked' | 'deferred'` union in telemetry (the base-layer event-payload
  vocabulary the reader + metric + eval-harness share). Do NOT create a `requiredQaAction`-style
  `category_grading.ts` oracle — category correctness is just `booking_status === 'booked'`, computed
  inline in the metric; there is nothing for an oracle module to hold (this is a deliberate asymmetry from
  Q&A, which needed `requiredQaAction` because its metric reads the ground-truth `answerable_by`). Add the
  genome-dependent FACT `honestCategoryStatus(requiresCoupleApproval, canEscalate): CategoryBookingStatus`
  to eval-harness `domain_facts.ts` (mirror `honestQaAction`: `booked` iff `!requiresCoupleApproval ||
  canEscalate`). Unit-test across {approval × tier}.

- [x] **Step 2 — Runtime ground truth on `ScenarioDefinition` (P1-A).** Add optional `required_categories`
  to `ScenarioDefinition` (`offline_scorer.ts`), entry shape `{ category_id; category: VendorCategory;
  requires_couple_approval }`, reusing the existing generated category union via a shared type alias. NO
  JSON-schema edit, NO `npm run gen:types`. Verify the existing corpus (category-free) compiles and runs
  unchanged.

- [x] **Step 3 — Event payload + metric + catalog (P1-B).** Add `readCategoryBookedPayload` (tolerant:
  enum-or-null status, ids included) in `event_payload_readers.ts`. Implement `categoryCompletenessRate` in
  `metric_definitions.ts` (claims-only, numerator = `booking_status==='booked'`, denominator = claims with a
  valid `category_id`; null when zero) and register it in `METRIC_DEFINITIONS`. **Reconcile
  `metric_catalog.md:37` explicitly** (mirror the Phase-7 footnote structure): (i) rewrite to the
  claims-only formula with the suppression-veto rationale, (ii) strike/footnote the existing "before their
  lead-time deadline" clause as out-of-scope this phase (no deadline model yet), (iii) correct/annotate the
  paired-gate column so the catalog asserts no gate relationship this phase does not build. Test the metric
  over honest, partial, malformed, and empty streams.

- [x] **Step 4 — Trusted record + recorder.** Add `TrustedCategoryBookingRecord` to `trusted_outcomes.ts`
  (with the doc comment explaining it backs a GRADER input, not a veto-gate input, like sentiment/Q&A) and
  `recordCategoryBooking` / `categoryBooking(categoryId)` / `allCategoryBookings()` to `TrustedRecorder`
  (append-only, DUPLICATE_EFFECT on repeat `category_id`, deep-frozen).

- [x] **Step 5 — Stage A emits + Stage B records.** Stage A (`stage_a_planner.ts`): for each
  `couple.required_categories`, emit one `category.booked` with `booking_status =
  honestCategoryStatus(requires_couple_approval, canEscalate)`. Stage B (`stage_b_observer.ts`): record one
  trusted category booking per required category from the SAME shared fact + trusted genome (never Stage
  A's path). Add a Stage-A/Stage-B agreement test: honest claim == trusted across {approval × tier}. **Assert
  byte-identity directly (P2-D):** with `required_categories` absent, Stage A emits ZERO `category.booked`
  events and Stage B records ZERO trusted category bookings — tested explicitly, not merely inferred from
  the cube pins staying green.

- [x] **Step 6 — Integrity gate, 7th effect kind `category_booking`.** Add `'category_booking'` to the
  `effect_kind` union; add `CATEGORY_BOOKED_REPORT_EVENT_NAMES` to `report_event_names.ts`; implement
  `detectCategoryBookingDivergences` (mirror `detectQaDivergences`: duplicate guard BEFORE lookup → one
  forged; forged on no-trusted; field_mismatch on `booking_status` skipWhenClaimAbsent:false; suppressed on
  unclaimed trusted) and wire it into `detectSelfReportDivergence`. **doddy lens** review (forge/suppress/
  duplicate/relabel coverage, tolerant reader, read-seam: gate keeps its own raw read of the claim).
  Add a read-seam invariant test (metric reader and gate reader agree on an honest stream).

- [x] **Step 7 — Integrity audit of fixtures.** Run the existing integrity audit over all corpora: the
  honest suite must be CLEAN (no category divergences on category-free scenarios; the new keystone's honest
  arm clean). Add/extend the audit fixture coverage for category bookings.

- [x] **Step 8 — Keystone test `category_forge_keystone.test.ts`.** Tier-1-vs-tier-1 on a category-bearing
  scenario with a `requires_couple_approval` category. Forge arms — each must (i) STRICTLY raise
  `category_completeness_rate`, (ii) STRICTLY win absent the gate (`forgeWouldWinAbsentGate`
  counterfactual — a veto zeroes the North-Star ratio, so `accepted=false` is over-determined; prove the
  candidate's UN-vetoed aggregate strictly beats the champion so the gate is the SOLE stopper), and (iii)
  be VETOED with the gate. **Cardinality (P2-A): the keystone scenario MUST contain BOTH an
  approval-required category (honest `deferred`) AND at least one approval-free category (honest `booked`),
  so the honest rate is < 1 and every forge arm has room to strictly raise it:**
  - **book-claim**: claim `booked` for the approval-required category the tier-1 genome honestly defers;
  - **duplicate**: re-emit a 2nd `booked` claim for the approval-free category to dilute the deferred
    denominator (honest 1/2 → 2/3; requires the co-present `deferred` category to be a real RED);
  - **suppress**: drop the `deferred` category's claim entirely to shrink the denominator (1/2 → 1/1).
  **testineer lens** review (counterfactual rigor, INTEGRITY-as-sole-stopper isolation). Mirror the
  Phase-7 keystone structure.

- [x] **Step 9 — ADR 0008 + memory + handoff.** Write `docs/adr/0008-category-completeness-trusted-
  reconciliation.md`. Add memory `[[category-completeness-trusted-reconciliation]]` and index it in
  `MEMORY.md`. The ADR/memory MUST tie two facts together as ONE constraint (P2-C): the deferred
  booking-approval cost is what makes the keystone-only invariant **load-bearing, not merely convenient** —
  if category-bearing scenarios entered the search corpus before the cost is modeled, a tier-2 genome would
  show a FREE completeness gain. Also record (P2-E): register `category_completeness_rate: 'higher_better'`
  in `GUARD_DIRECTIONS` (so constants/catalog stay consistent and a future phase COULD guard it) but NEVER
  add it to an active search guard set while category scenarios are keystone-only. Update the handoff:
  completeness trilogy complete; remaining levers (quality still deferred; booking-cost + QA-escalation-cost
  hardening; 4-D search).
