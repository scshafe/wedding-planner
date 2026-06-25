# Phase 7 — Trusted Q&A reconciliation (close the LAST claimed-only completeness metric)

## Why this, why now

`completeness` (North-Star numerator, weight 0.35) is the mean of three value-metrics
(`metric_normalization.ts:41-45`): `rsvp_resolution_rate` (trusted-backed, Phase 4b),
`category_completeness_rate` (unimplemented), and **`qa_accuracy_rate`** — named in the catalog and the
completeness mean but with **no metric function, no simulator model, and no trusted backing**. After
Phase 6, sentiment is trusted-backed; `qa_accuracy_rate` is now the LAST *named-and-wired* claimed-only
completeness metric. Closing it completes a citable milestone: **every computed North-Star input is
trusted-backed except `quality`** (honestly deferred for API-credential reasons).

## The load-bearing insight (why a naïve Q&A model would be VACUOUS)

For the integrity firewall to be **load-bearing**, the trusted record (Stage B) must be able to
*disagree* with a forged claim **in a way the metric rewards**. For rsvp/sentiment that holds because
the honest OUTCOME is forced by ground truth + genome (a guest resolves iff reminders meet its need;
sentiment is a pure function of reach) — so Stage B re-derives it and a liar diverges.

A naïve Q&A model where the honest planner is **always correct** (answer `ai_from_known_facts`,
escalate `requires_couple`, refuse `must_refuse`) is **vacuous**: honest `qa_accuracy_rate` is pinned
at 1.0, the trusted action always equals the correct action, and the only claims a liar can make that
diverge from trusted are ones that *lower* its own metric. There is nothing to forge *up*. A gate that
can only catch self-harming lies is not load-bearing.

**The fix (no new search knob): Q&A competence is genome-dependent via the EXISTING tier-2
`autonomy_threshold` knob.** Escalating a `requires_couple` question to the couple **consumes couple
attention/authority** — exactly the `commitment_autonomy` surface that makes `autonomy_threshold`
tier-2 (`risk_tier.ts:90-100`). So:

- A `requires_couple` question is handled correctly **only by escalating** → requires the genome to
  carry `autonomy_threshold` (tier-2). The honest tier-2 planner escalates it (qa correct) **and pays
  the couple-attention cost** (the existing Phase-4b `couple_active_minutes_total → effort_cost`).
- A **tier-1** genome (no `autonomy_threshold`, the canonical search form) **cannot escalate** → its
  honest action on a `requires_couple` question is `answered` (it attempts from incomplete knowledge),
  which is **incorrect** → honest `qa_accuracy_rate < 1.0`.
- `ai_from_known_facts` → `answered` (correct at any tier); `must_refuse` → `refused` (correct at any
  tier). Only `requires_couple` is tier-gated. (`must_refuse` does NOT feed any COMMS veto gate in this
  phase — the Q&A model stays inside the metric/grader-input firewall, no gate entanglement.)

**The forge this makes load-bearing:** a **tier-1** candidate that **claims it escalated** a
`requires_couple` question (claimed `action_taken='escalated'` → qa correct → `qa_accuracy_rate` up)
**without** the couple-attention cost — getting tier-2-grade completeness for free. The trusted record
(Stage B, re-derived from the tier-1 genome) says the honest action was `answered`, so claimed
`escalated` ≠ trusted `answered` → **field_mismatch → veto**. Absent the gate this strictly dominates a
tier-2 champion (same completeness, lower effort_cost); with the gate it is rejected. That is the
keystone.

**Why this keeps every existing invariant:**
- **The search landscape is untouched.** `qa_accuracy_rate` returns `null` when a scenario has no
  questions (zero denominator), and the entire search/oracle corpus (`makeGuest` → `questions: []`,
  `KEYSTONE_GUESTS`, `DEFAULT_GUESTS`) is question-free. So the pinned 2-D matrix and 3-D cube in
  `metamorphic_oracle.test.ts`, and all North-Star values, are **unchanged**. Q&A only enters scoring
  in question-bearing corpora (the new keystone).
- **The tier-1 search box stays tier-1 and forge-free.** Q&A is null in the box; correct Q&A handling
  of `requires_couple` *requires* tier-2, which the promotion gate already PARKS
  ([[tier2-promotion-gate-is-load-bearing]]). The autonomous tier-1 search can never legitimately lift
  Q&A on those questions — an honest limitation, not a forge.
- **INVARIANT (review finding): question-bearing scenarios are KEYSTONE-ONLY — never in the autonomous
  search corpus.** Because Q&A correctness on `requires_couple` is tier-gated, an honest tier-1 search
  candidate scored on a question-bearing scenario against an enthroned tier-2 champion would
  *guard-regress* on `qa_accuracy_rate` (a registered `higher_better` guard, `scoring_constants.ts:62`)
  — making the qa guard un-satisfiable for honest tier-1 candidates. Keeping question-bearing scenarios
  out of the search corpus (they live only in the Q&A keystone) preserves both the cube pins and the
  tier-1 search's ability to win. Record this in memory.
- **Grader-input, not veto-gate-input.** Like sentiment (Phase 6), this extends the firewall to a
  North-Star *numerator* input; it does NOT change the integrity-gate completeness invariant
  ([[integrity-gate-completeness-invariants]], which concerns fields *veto gates* read). Document so a
  future reader does not conclude Q&A must become a gate input.

## The design (the firewall pattern, applied to Q&A)

- **SHARED FACT** in `domain_facts.ts`:
  `requiredQaAction(answerableBy): 'answered'|'escalated'|'refused'` (the bijection ai→answered,
  requires_couple→escalated, must_refuse→refused) and
  `honestQaAction(answerableBy, canEscalate): 'answered'|'escalated'|'refused'` — equals
  `requiredQaAction` EXCEPT a `requires_couple` question with `canEscalate=false` returns `answered`
  (the tier-1 honest-but-incorrect action). `canEscalate = autonomy_threshold !== undefined`. Both
  stages call these — Stage A to EMIT, Stage B to RECORD — so honest claims are **bit-identical** to
  the trusted record (no honest-run false positive, by shared computation, the Phase-6 argument).
- **Metric** `qa_accuracy_rate` over the CLAIMED `guest.question.answered` stream:
  numerator = answers where `action_taken === requiredQaAction(answerable_by_expected)`; denominator =
  number of answered claims; `null` when 0 (honest-undefined). It reads BOTH claimed fields, so BOTH
  are reconciled (below). **Denominator = claims-only** (NOT the catalog's historical
  `count(answered ∪ should-have-answered)`): suppressing a question the planner gets wrong is caught by
  the gate's `suppressed_effect` arm (a trusted question with no claim → veto), so the
  `∪ should-have-answered` term is unnecessary and the claims-only form mirrors the proven Phase-6
  sentiment denominator. **`metric_catalog.md:56` + its footnote² MUST be updated in Step 3** to this
  claims-only formula with this rationale (contracts-as-source-of-truth: do not leave the catalog and
  the implemented metric disagreeing). `correct` here is `action_taken` matching
  `answerable_by_expected` only — the `answer_fact_id` half of the catalog's `correct` footnote stays
  out of scope (no fact-assertion model in this phase).
- **Trusted record** `TrustedQaOutcomeRecord { guest_id, question_id, answerable_by, action_taken }`,
  one per scripted question, keyed by the composite `guest_id|question_id`. `answerable_by` = persona
  ground truth; `action_taken` = `honestQaAction(answerable_by, canEscalate)`.
- **Integrity gate: 6th effect kind `qa_outcome`** keyed by `guest_id|question_id`:
  **forged** (a claimed answer with no trusted question — phantom question — OR a **duplicate**
  (guest,question) claim, the cardinality guard the per-question denominator needs, mirroring the
  Phase-6 sentiment duplicate veto), **field_mismatch** (`action_taken` OR `answerable_by_expected`,
  `skipWhenClaimAbsent:false` so an absent/blank field against a trusted value is a veto), **suppressed**
  (a trusted question with no claim — dropping a question the planner gets wrong would otherwise raise
  the rate).
- **Reconciling `answerable_by_expected` is load-bearing, not redundant** (review Q4): the metric reads
  it, so a forge can lie about it to relabel a `requires_couple` question as `ai_from_known_facts` and
  make a *truthful* `action_taken='answered'` score as correct (`requiredQaAction('ai')='answered'`) —
  with no escalation and no couple cost. Reconciling `action_taken` ALONE would miss this; reconciling
  the persona ground-truth claim against the trusted persona value closes it (the `verified`/`rsvp_status`
  precedent — the gate trusts the persona, not the claim). `answerable_by_expected` is OPTIONAL in the
  schema but the honest emit path MUST always populate it (with `skipWhenClaimAbsent:false` an omission
  is a veto) — see the Step-4/7 invariant.
- **Duplicate-check ordering** (review): mirror `detectSentimentDivergences` exactly — test the
  duplicate composite key BEFORE the trusted lookup and `continue`, so a duplicate yields one
  `forged_effect`, not also a spurious `field_mismatch`.

## Conventions (match the repo)

Green per step (`npm run build` standalone — check `$?`, never pipe to tail/grep — then `npm test &&
npm run lint`); commit per verified step; branch `build/phase-3-generalize-search` (the open review
artifact). Route adversarial review through `general-purpose` agents carrying the doddy (trust
boundary), wolf (stats/aggregation), rigorous-architect (design), and testineer (test strategy) lenses
(named subagents are not provisioned here).

## Steps

- [x] **Step 0 — Design review of the load-bearing core (before building).**
  DONE — rigorous-architect proxy reviewed: APPROVE-WITH-CHANGES, core thesis verified non-vacuous
  (numerically: tier-2 champion 0.9917 vs honest tier-1 0.7083 vs tier-1 forge 1.0000, caught by
  field_mismatch). All 5 findings folded into this plan (claims-only denominator + catalog reconcile;
  keystone empty guard set + question-bearing-scenarios-are-keystone-only invariant; dropped the
  promotion-gate verification language; answerable_by_expected always-emit invariant + fixture audit;
  the relabel-attack arm + duplicate-check ordering).
  Get a `rigorous-architect`-lens review of THIS plan's central claims: (a) the vacuity argument and
  the autonomy_threshold tier-gating fix; (b) that the gate is non-vacuous (a forge that pays absent the
  gate exists and is caught); (c) that no existing invariant (cube pins, tier-1 box, tier-2 park,
  completeness invariant) is weakened. Apply findings to the plan before Step 1.

- [x] **Step 1 — SHARED Q&A facts.**
  DONE — grader oracle `requiredQaAction` + `QaAnswerableBy`/`QaAction` live in NEW
  `telemetry/src/metrics/qa_grading.ts` (telemetry is the base layer the metric reads → ONE definition
  of correctness, respecting eval-harness→telemetry). `honestQaAction(answerableBy, canEscalate)` stays
  in `domain_facts.ts` (imports `requiredQaAction` from telemetry). Unit test `qa_facts.test.ts` pins
  the bijection + the single tier-gated `requires_couple`+tier-1 → `answered` case. 267 tests green.
  Add `requiredQaAction(answerableBy)` and `honestQaAction(answerableBy, canEscalate)` (pure, with the
  tier-gating docblock: requires_couple needs escalation capability; share the FACT not the claim path).
  Unit test the mapping incl. the tier-1 requires_couple → `answered` case. No behavior change to
  existing code (new functions only).

- [x] **Step 2 — Trusted Q&A outcome type + recorder method.**
  DONE — `TrustedQaOutcomeRecord {guest_id, question_id, answerable_by, action_taken}` +
  `RecordQaOutcomeInput` in `trusted_outcomes.ts`; `recordQaOutcome`/`qaOutcome(guestId, questionId)`/
  `allQaOutcomes()` on the recorder, keyed by a printable collision-free composite key
  (`JSON.stringify([guestId, questionId])` — NOT a NUL byte, which would binary-poison the source),
  append-only + sealed-guard + deep-frozen. Tests cover record/retrieve/aggregate, duplicate veto,
  same-question-id-under-different-guests (composite key), and sealed. 271 tests green.
  `trusted_outcomes.ts`: `TrustedQaOutcomeRecord { guest_id, question_id, answerable_by, action_taken }`
  + input type, with a docblock (backs `qa_accuracy_rate`; grader-input not gate-input; composite key).
  `trusted_recorder.ts`: `recordQaOutcome` / `qaOutcome(guestId, questionId)` / `allQaOutcomes()` —
  append-only (DUPLICATE_EFFECT on repeat composite key), sealed-guard, deep-frozen — mirroring
  `recordSentimentObservation`. Tests: append-only + sealed + retrieval by composite key.

- [x] **Step 3 — Telemetry: payload reader + the `qa_accuracy_rate` metric (+ catalog reconcile).**
  DONE — TOLERANT `readGuestQuestionAnsweredPayload` (enum-or-null for action/answerable, so an
  adversarial/malformed claim scores conservatively + lets the gate veto, never crashes scoring);
  `qaAccuracyRate` (claims-only, correct = action matches `requiredQaAction(answerable)`, null when 0)
  registered + exported. `metric_catalog.md` formula + footnote updated to claims-only with rationale.
  `qa_accuracy.test.ts`: all-correct → 1.0, mixed → 0.5, missing-field → conservative, empty → null.
  275 tests green.
  `event_payload_readers.ts`: `readGuestQuestionAnsweredPayload` (guest_id, question_id,
  answerable_by_expected, action_taken — validated enums). `metric_definitions.ts`: `qaAccuracyRate`
  (claims-only numerator/denominator/null per the design) registered in `METRIC_DEFINITIONS`. **Update
  `telemetry/metric_catalog.md:56` + footnote²** to the claims-only formula with the suppression-veto
  rationale (contracts-as-source-of-truth — no catalog/impl drift). Tests
  (`metric_engine`/definitions): a mixed correct/incorrect stream yields the right rate; no answered
  events → null; an all-correct stream → 1.0.

- [x] **Step 4 — Stage A emits `guest.question.answered` per question.**
  DONE — `rsvpCadencePlanner` emits one `guest.question.answered` per scripted question (always with
  `answerable_by_expected`), `action_taken = honestQaAction(answerable_by, canEscalate)` where
  `canEscalate = autonomy_threshold !== undefined`. Question-free guests emit nothing → cube/oracle
  byte-unchanged (existing suite still green). `stage_a_qa.test.ts`: tier-2 escalates requires_couple
  (qa 1.0), tier-1 answers it (qa 0.0), ai/refuse correct at both tiers, no questions → null. 279 green.
  In `rsvpCadencePlanner`, after the RSVP/sentiment loop, for each guest question emit
  `guest.question.answered` with `action_taken = honestQaAction(answerable_by, canEscalate)` and
  `answerable_by_expected = answerable_by`, where `canEscalate = genome.parameters.autonomy_threshold
  !== undefined`. **Always populate `answerable_by_expected`** (the invariant the gate's
  `skipWhenClaimAbsent:false` relies on). Guests with no questions emit ZERO `guest.question.answered`
  events (no empty-loop artifact) so question-free corpora are byte-unchanged — re-confirm the
  cube/oracle suite stays green. Test (`stage_a` / metamorphic): honest qa = 1.0 for a tier-2 genome on
  a requires_couple question; < 1.0 for a tier-1 genome on the same; null when no questions; the
  existing question-free streams unchanged.

- [x] **Step 5 — Stage B authors a trusted Q&A outcome per scripted question.**
  DONE — `observeTrustedRecord` records one `recordQaOutcome` per question via `honestQaAction` on the
  TRUSTED genome's `canEscalate`. Agreement sweep in `stage_b_observer.test.ts`: trusted
  (action, answerable_by) == honest Stage A claim for every answerable_by × {tier-1, tier-2}, plus
  one-per-question / none-for-question-free. 282 green.
  Extend `observeTrustedRecord`: for each guest × question, `recordQaOutcome({ guest_id, question_id,
  answerable_by, action_taken: honestQaAction(answerable_by, canEscalate) })`, `canEscalate` from the
  TRUSTED genome (never Stage A). Test (`stage_b_observer`): the **agreement sweep** — trusted action ==
  honest Stage A claim for every (answerable_by ∈ {ai,couple,refuse}) × (tier-1, tier-2) combination,
  so honest runs are gate-clean.

- [ ] **Step 6 — Integrity gate: the 6th reconciled effect kind `qa_outcome`.**
  `report_event_names.ts`: `QA_ANSWERED_REPORT_EVENT_NAMES = { guest.question.answered }` with the
  reader-seam docblock. `integrity_gate.ts`: add `'qa_outcome'` to the `effect_kind` union and
  `detectQaDivergences` keyed by `guest_id|question_id` — forged (no trusted question / duplicate
  composite key), field_mismatch (`action_taken` AND `answerable_by_expected`, `skipWhenClaimAbsent:
  false`), suppressed (trusted question, no claim). Wire into `detectSelfReportDivergence`. Unit tests:
  each arm yields the right kind; an honest stream (tier-1 AND tier-2) is clean.

- [ ] **Step 7 — Audit existing fixtures + wire qa into completeness end-to-end.**
  `qa_accuracy_rate` is already in the completeness mean (`metric_normalization.ts:43`); confirm the
  full honest suite stays green (question-free fixtures → qa null → completeness unchanged). **Grep
  every test/fixture for a bare `guest.question.answered`** emission: any hand-built recorder test that
  emits one needs both a matching trusted `recordQaOutcome` AND a populated `answerable_by_expected`
  (the `skipWhenClaimAbsent:false` field-diff vetoes an omission). The whole suite green; the pinned
  cube/matrix unchanged.

- [ ] **Step 8 — THE keystone: a Q&A forge does not pay (tier-1 claims tier-2-grade handling).**
  New `loop-orchestrator/tests/loop/qa_forge_keystone.test.ts`. Corpus with a guest carrying a
  `requires_couple` question. Champion = a TIER-2 genome (escalates → qa 1.0, pays couple cost).
  Candidate = a TIER-1 genome; its HONEST qa < 1.0 (answers the requires_couple question wrong) so it
  does NOT win honestly. Use an **empty guard set** (`guardSpecsFor([])`, mirroring the sentiment
  keystone) so the qa guard-regression of an honest tier-1 vs a tier-2 baseline does not mask the
  integrity claim — INTEGRITY must be the demonstrated stopper. Forge arms (lying Stage A,
  candidate-only): (a) claim `action_taken='escalated'` (qa up to 1.0, no couple cost — the headline
  forge); (b) **suppress** the wrong answer (drops a 0 from the rate); (c) **duplicate** a correct
  answer to re-weight; (d) lie about `answerable_by_expected` to relabel the couple-question as
  AI-answerable (forges correctness via the required-action mapping, not just the field). Each moves
  `qa_accuracy_rate` favourably (RED) yet yields a NEW integrity failure and is rejected (GREEN).
  Companion: the honest tier-1 candidate is gate-CLEAN (the veto targets the lie, not the model) — it
  simply does not win. NOTE: the `scoreCandidateOffline` path applies NO tier/promotion park (that
  lives in `loop-orchestrator/.../promotion_gate.ts`, invoked by `genome_offline_loop.ts`), so
  integrity is trivially the sole gate in this harness; the candidate's tier-1 status is what makes it
  the sole stopper in the full loop too. (Do not add promotion-gate verification language — this path
  doesn't run it.)

- [ ] **Step 9 — ADR 0007 + memory + handoff.**
  `docs/adr/0007-qa-accuracy-trusted-reconciliation.md` (the vacuity insight, the autonomy_threshold
  tier-gating, the grader-vs-gate-input distinction, the "all computed inputs trusted-backed except
  quality" milestone). New memory `[[qa-accuracy-trusted-reconciliation]]`; update
  [[tier2-promotion-gate-is-load-bearing]] (autonomy_threshold now also gates Q&A escalation) and
  `MEMORY.md`. Update `.claude/handoff.local.md`.

## Adversarial review gates (apply findings before ticking)

- **rigorous-architect** at Step 0 (design) and after Step 6 (is the qa_outcome reconciliation
  genuinely independent; is the effect-kind set still single-authored at the report-event seam).
- **doddy (trust boundary)** after Step 6: is the forged/field_mismatch/suppressed/duplicate quad
  complete for a per-question effect; does reconciling BOTH `action_taken` and `answerable_by_expected`
  close every correctness-forge path; is the composite-key cardinality guard correct.
- **wolf (stats)** after Step 5: confirm the bit-identity agreement across all (answerable_by × tier)
  combinations (no honest false-positive), and that each keystone forge truly moves the rate (RED real).
- **testineer** after Step 8: is the keystone RED load-bearing (the tier-1 forge genuinely
  out-competes the tier-2 champion absent the gate — same completeness, lower effort_cost), and are the
  oracle relations live, not pinned snapshots.

## Out of scope (recorded, not faked)
- `quality` North-Star component (needs a real judge → STOP rail; a stub → fabrication rail).
- `category_completeness_rate` (the third completeness metric; no plan-state simulator model yet).
- A Q&A *search knob* / 4-D search — deliberately avoided; Q&A competence rides the existing tier-2
  knob, keeping the search question-free and the cube pins intact.
- `must_refuse` → COMMS veto-gate entanglement (surprise-leak gating); Q&A stays a grader-input here.
- Prod key-custody for the trusted feed ([[prod-trusted-evidence-channel]]).
