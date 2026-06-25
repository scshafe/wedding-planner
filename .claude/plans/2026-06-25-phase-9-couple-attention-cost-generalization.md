# Phase 9 — Trusted couple-attention COST for booking-approval & Q&A escalation (generalize `couple_session`)

## Why this, why now

Phase 7 (Q&A) and Phase 8 (category) **both** flagged the SAME deferral as their cleanest follow-on:
escalating to the couple — for a `requires_couple` question, or to secure approval on a
`requires_couple_approval` category booking — **consumes couple commitment-authority but is charged NO
couple cost today**. Only RSVP escalation (Phase 4b) charges a couple-attention cost
(`couple.session.ended → active_seconds → couple_active_minutes_total → effort_cost`, the North-Star
denominator). The trusted couple-session record is keyed **per guest** (`coupleSessionsByGuestId`,
`trusted_recorder.ts:70`) — a key that **collides** the moment a guest carries more than one escalation
reason, and that **cannot represent a category escalation** at all (a booking approval is not
guest-scoped).

This is **load-bearing, not cosmetic**. Both prior phases noted: *"the deferred booking-approval cost
and the keystone-only invariant are ONE constraint"* — if a category-bearing (or question-bearing)
scenario ever entered the autonomous search corpus before the cost is modeled, a tier-2 genome would
show a **FREE completeness / qa_accuracy gain** (it books/answers the approval item with no offsetting
couple cost). Modeling the cost closes that hole.

It is also the **prerequisite for the `quality` capstone.** `quality` (weight 0.40, the single largest
unbuilt value lever, still `null` — `metric_normalization.ts:40`) stays honestly deferred behind the
judge→STOP / stub→fabrication rail (ADR 0007). But a *legitimate, load-bearing* `vision_match` quality
signal needs a degree of freedom that does not exist yet: the planner being able to **consult the
couple at a cost to raise selection quality** (the Goodhart guard `scoring_model.md:80` —
*"couple_active_minutes ↓ → guard: vision_match — don't win by deciding badly-but-fast"*). That guard is
only meaningful once consultation HAS a cost. This phase builds that cost surface; a later phase can
then ride it for `vision_match`.

## The load-bearing insight (why the new cost is non-vacuous)

For the firewall to be load-bearing, the trusted record (Stage B) must be able to *disagree* with a
forged claim **in a way the North Star rewards** — there must be a genome-dependent honest cost to
forge DOWN. The couple-attention cost is incurred **only when the planner escalates**, which requires
the EXISTING tier-2 `autonomy_threshold` (`canEscalate`). So:

- A **tier-2** genome that honestly books a `requires_couple_approval` category (Phase 8:
  `honestCategoryStatus` → `booked`) **incurs a `booking_approval` couple session** — it had to take the
  couple's commitment-authority to do so. It gets the completeness AND pays the cost.
- A **tier-1** genome **defers** that category (Phase 8) → no booking, no cost (consistent).
- Symmetrically, a tier-2 genome that honestly escalates a `requires_couple` question (Phase 7:
  `honestQaAction` → `escalated`) **incurs a `qa_escalation` couple session**.

**The forge this makes load-bearing (the new surface):** a **tier-2** candidate that books the
approval-category / escalates the question (keeping the completeness / qa_accuracy) but **shaves or
suppresses the couple-attention cost** — claiming tier-2-grade *outcomes* with sub-tier-2 *cost* →
lower `effort_cost` → higher North Star. The trusted record (Stage B, re-derived from the same genome)
holds the honest cost, so a shaved `active_seconds` → **field_mismatch**, a dropped session →
**suppressed_effect** → **veto**. Absent the gate the shaver strictly dominates an honest champion
(identical outcomes, lower cost); with the gate it is rejected. That is the keystone. (This mirrors the
Phase-4b RSVP cost-shave forge, now generalized to the two new escalation reasons.)

## The fix: generalize `couple_session` to a per-`(reason, target)` key

One mechanism, three reasons. The existing per-guest RSVP path is preserved byte-for-byte; the key
becomes composite so the two new reasons coexist.

- **Vocabulary:** `CoupleSessionReason = 'rsvp_escalation' | 'qa_escalation' | 'booking_approval'`.
- **Join key:** generalize the gate's join key from `about_guest_id` to the composite
  `(session_reason, about_id)` where `about_id` = `guest_id` (rsvp), `question_id` (qa), or
  `category_id` (booking). The RSVP path passes `session_reason: 'rsvp_escalation'`, `about_id: guest_id`
  → identical reconciliation.
- **The metric is already reason-agnostic.** `couple_active_minutes_total` sums `active_seconds` across
  ALL `couple.session.ended` events (`metric_definitions.ts:61-69`); it never reads the join key. So new
  sessions automatically feed `effort_cost`, and **byte-identity holds on the search corpus** (no
  category/question scenarios there → zero new sessions).

## Why this keeps every existing invariant

- **The search landscape is byte-identical.** The new sessions fire ONLY when an
  `requires_couple_approval` category is booked or a `requires_couple` question is escalated — both
  KEYSTONE-ONLY (Phase 7/8: `required_categories` and `guest_persona.questions` are absent from the
  search corpus; tier-1 search candidates cannot escalate at all). The pinned 2-D matrix / 3-D cube and
  every search-corpus North-Star value are unchanged. Assert this directly (zero new sessions on the
  category/question-free corpus), mirroring Phase 8 Step 5.
- **The Phase-4b RSVP couple_session path is behaviorally unchanged** — same event, same metric
  contribution, same reconciliation; the `integrity_rsvp_couple.test.ts` keystone stays green. The only
  change to RSVP is that it now carries an explicit `session_reason: 'rsvp_escalation'` discriminator.
- **Independence → no honest self-veto.** Stage A (claim) and Stage B (trusted) both derive each
  session's existence + `active_seconds` from the SAME shared honest-cost facts on the SAME trusted
  genome — bit-identical, so the exact field-diff never self-vetoes (the Phase-6 shared-computation
  argument). Pinned by an agreement sweep across reason × tier.
- **Grader/denominator input, not a NEW veto-gate input.** The cost feeds the North-Star *denominator*;
  reconciling it extends the firewall (like Phase 4b/6/7/8) without changing the integrity-gate
  *completeness* invariant ([[integrity-gate-completeness-invariants]], which concerns fields VETO gates
  read). Document so a future reader does not conclude couple sessions are a veto-gate input.
- **Keystone-only stays the structural invariant.** This phase models the cost but does NOT move
  category/question scenarios into the search corpus (that is a separate, larger decision — see
  Out-of-scope). With the cost modeled, a future keystone MAY use a literal tier-2 champion (the tier-1
  forge now dodges a real cost), strengthening Phase 7/8 keystones; that upgrade is optional follow-on.

## Design review outcome (Step 0, DONE — architect lens, APPROVE-WITH-CHANGES)

A `general-purpose` agent carrying the rigorous-architect lens reviewed this plan (the named specialists
are not provisioned here). Verdict **APPROVE-WITH-CHANGES**: the core thesis (composite `(reason,
about_id)` key, one gate function, shared constant) is correct, load-bearing for BOTH reasons, and
byte-identity-preserving. Land both reasons together (one shared mechanism — splitting would migrate the
key twice). Findings folded into the steps below:

1. **Gate the booking-approval session on `requires_couple_approval === true && canEscalate`, NOT on
   `honestCategoryStatus === 'booked'` alone** — an approval-FREE category is `booked` at any tier and
   must incur NO couple cost. (Predicate simplifies: booking session iff `requires_couple_approval &&
   canEscalate`; qa session iff `answerable_by === 'requires_couple' && canEscalate`.) Unit-test the
   approval-free-booked → no-session case.
2. **CORRECTION (the architect lens AND my own first grep searched only `eval-harness/` — both missed
   the keystones, which live in `loop-orchestrator/tests/loop/`).** The handoff was ACCURATE:
   `category_forge_keystone.test.ts` (and `qa_forge_keystone.test.ts`) exist there and DO define
   `forgeWouldWinAbsentGate` + `onlyIntegrityFailed` as LOCAL helpers (not exported) using
   `scoreCandidateOffline` + a `liar` planner that mutates ONLY the candidate's events. So Phase 9's
   load-bearingness is proven by BOTH layers, matching Phase 8: (a) gate-level forge detection
   (extend `integrity_rsvp_couple.test.ts`, the `detectCoupleSessionDivergences` arms) AND (b) a full
   North-Star keystone `couple_cost_forge_keystone.test.ts` in `loop-orchestrator/tests/loop/` mirroring
   `category_forge_keystone.test.ts` (assert: metric moved, `forgeWouldWinAbsentGate`, `onlyIntegrityFailed`,
   `accepted=false`). The Step 8 back-port to the Phase-6 sentiment keystone IS still pending (the helpers
   exist in qa/category keystones but NOT in `sentiment_forge_keystone.test.ts`) — so it is restored.
3. **Relabel safety comes from the composite key itself, not a separate reason-diff:** a claimed
   `(reason', about_id)` that mismatches the trusted reason MISSES the lookup → `forged_effect`, and the
   trusted `(reason, about_id)` goes unclaimed → `suppressed_effect`. So a reason-relabel is caught as
   forged + suppressed even under today's uniform `active_seconds`. Record in the ADR that uniform
   magnitude is what keeps relabel cost-NEUTRAL (no cheaper bucket to move to); a future
   magnitude-differentiating phase is still safe because the key miss catches it — but it must keep
   `session_reason` in the key. Do not enshrine "reason is purely cosmetic."
4. **`requireNumber(active_seconds)` THROWS (uncaught by the metric engine) on an absent/non-numeric
   value.** Phase 9's forge tests are GATE-LEVEL (they call `detectSelfReportDivergence` directly, which
   handles absent via `skipWhenClaimAbsent:false` without invoking the metric) — so no throw. But never
   author a full-scoring test with an absent `active_seconds`; use present-but-lower (shave) or
   full-event-drop (suppress).
5. **Keep `CoupleSessionEndedPayload` reader unchanged** (`session_id` + `active_seconds` only) — the
   metric must not read `session_reason`/`about_id`. Pin with a read-seam test (the metric reader and the
   gate reader agree on an honest reason-bearing stream).
6. **Backward-compat is a migration, not a no-op.** The field rename `about_guest_id → about_id` + new
   `session_reason` touches these tests, which must be migrated (then green), not left untouched:
   `tests/gates/integrity_rsvp_couple.test.ts` (esp. the `d?.field === 'about_guest_id'` assertion flips
   to `'about_id'`), `tests/simulator/stage_b_observer.test.ts` (`allCoupleSessions()` shape),
   `tests/trusted_recorder/integrity_boundary.test.ts`, `tests/simulator/stage_a_escalation.test.ts`
   (verify payload assertions; event NAME is unchanged). `telemetry/tests/fixtures/sample_event_stream.ts`
   couple sessions feed the metric only (no join key) → survive.
7. **The honest-run sweep must include a MULTI-REASON CO-PRESENT scenario** (e.g. one scenario carrying
   an RSVP escalation AND a question AND a required category, at tier-2) so it regression-guards the
   composite key — a sweep over separate single-reason scenarios would pass even under the OLD per-guest
   key and not guard the actual fix.
8. **Divergence-arm ordering** (mirror `detectCategoryBookingDivergences`): missing-join-field → duplicate
   (2nd claim for same `(reason, about_id)` → one `forged_effect`, before the trusted lookup) → no-trusted
   (forged) → field-diff (`active_seconds`). Unknown/garbage `session_reason` naturally falls out as
   `forged_effect` (no trusted match).

## Steps
- [x] **Step 1 — Vocabulary + payload generalization.** Add `CoupleSessionReason` to the telemetry
  vocabulary/constants. Generalize the `couple.session.ended` integrity-join fields: `session_reason` +
  `about_id` (the RSVP path migrates from `about_guest_id` → `session_reason:'rsvp_escalation'`,
  `about_id:guest_id`). The telemetry payload reader (`event_payload_readers.ts`) continues to read
  `session_id` + `active_seconds` for the metric; `session_reason`/`about_id` are integrity-join fields
  read by the gate. Keep the existing event NAME (`couple.session.ended`). Build green.
- [x] **Step 2 — Trusted record + recorder composite key.** Generalize `TrustedCoupleSessionRecord` to
  `{ session_reason, about_id, active_seconds }`; rekey the recorder by the composite `(session_reason,
  about_id)` (replace `coupleSessionsByGuestId`). Keep `recordCoupleSession` / `coupleSession(...)` /
  `allCoupleSessions()` APIs; update the lookup signature to take `(reason, about_id)`. Update Phase-4b
  callers to pass `rsvp_escalation`. Build + existing tests green (RSVP behavior identical).
- [x] **Step 3 — Shared honest-cost facts** (mirror `category_facts.test.ts`). In `domain_facts.ts`, add
  the SHARED predicates both stages call: `honestBookingApprovalSession(requires_couple_approval,
  canEscalate)` = `requires_couple_approval && canEscalate`; `honestQaEscalationSession(answerable_by,
  canEscalate)` = `answerable_by === 'requires_couple' && canEscalate`. Each honest session uses a fixed
  `active_seconds` (reuse `COUPLE_SESSION_ACTIVE_SECONDS`). NO new oracle — compose existing honest facts.
  Test pins the load-bearing limitation (approval-free booked → NO session; tier-1 → NO session) so a
  refactor can't flatten it into vacuity.
- [x] **Step 4 — Stage A emit + Stage B record** (mirror `stage_category.test.ts`). Stage A emits one
  `couple.session.ended` (`session_reason`, `about_id`, `active_seconds`) per honest booking-approval /
  qa-escalation, driven by the Step-3 predicates; Stage B records the matching trusted session via the
  SAME predicates (bit-identical). Keyed by category_id / question_id. Assert byte-identity: ZERO new
  sessions on the category/question-free search corpus.
- [x] **Step 5 — Integrity gate generalization** (mirror `detectCategoryBookingDivergences` ordering).
  Generalize `detectCoupleSessionDivergences` to key on `(session_reason, about_id)`: missing-join-field
  → duplicate-as-forge (2nd claim for same composite key, before trusted lookup) → no-trusted (forged) →
  field_mismatch on `active_seconds` (`skipWhenClaimAbsent:false`) → suppressed (trusted, no claim). The
  `effect_id` becomes the composite-key string; `effect_kind` stays `'couple_session'`. Reason-relabel is
  caught by the key miss (forged + suppressed) — verify, don't add a redundant reason-diff. **doddy lens**
  review post-build: NO bypass across the reason cross-product; a shaved / suppressed / reason-relabelled
  session cannot lower effort while passing.
- [x] **Step 6 — Honest-run audit + read-seam (no self-veto).** (a) A sweep over {rsvp, qa, booking} ×
  {tier-1, tier-2} reconciling clean (Stage A ≡ Stage B, zero divergences) — a stage divergence on any
  reason would self-veto every honest tier-2 run. (b) **A MULTI-REASON CO-PRESENT scenario** (one tier-2
  scenario carrying an RSVP escalation + a `requires_couple` question + a `requires_couple_approval`
  category) reconciling clean — this is what actually regression-guards the composite key (the old
  per-guest key could not represent it). (c) Read-seam test: the metric reader
  (`readCoupleSessionEndedPayload`, session_id+active_seconds only) and the gate reader agree on an honest
  reason-bearing stream; `couple_active_minutes_total` sums all reasons.
- [x] **Step 7 — Forge keystone (both layers).** (a) Gate-level: extend `integrity_rsvp_couple.test.ts`
  with the new-reason arms (shave → field_mismatch; suppress → suppressed_effect; forged → forged_effect;
  reason-relabel → forged + suppressed). DONE for RSVP in Commit A; add booking_approval / qa_escalation
  coverage. (b) Full North-Star keystone `loop-orchestrator/tests/loop/couple_cost_forge_keystone.test.ts`
  mirroring `category_forge_keystone.test.ts`: a TIER-2 champion vs a TIER-2 candidate that honestly books
  the approval category AND escalates the question (same outcomes), then SHAVES then SUPPRESSES the
  booking_approval / qa_escalation couple cost. Each arm: `couple_active_minutes_total` strictly DOWN →
  aggregate ratio strictly UP, `forgeWouldWinAbsentGate(r) === true`, `onlyIntegrityFailed(r) === true`,
  `accepted === false`. Honest companion gate-clean. **testineer lens** review.
- [ ] **Step 8 — Back-port `forgeWouldWinAbsentGate` + `onlyIntegrityFailed`** to
  `sentiment_forge_keystone.test.ts` (the helpers exist in qa/category keystones but not there yet — the
  handoff's lever 3). Low-effort hardening; do if green.
- [ ] **Step 9 — ADR 0009 + memory + handoff.** ADR documenting the generalized cost surface, the
  load-bearing argument, the relabel/uniform-magnitude analysis (Step 0 finding 3), and the keystone
  decomposition (gate-level + full North-Star, both in the established pattern). Memory
  `[[couple-attention-cost-generalization]]` indexed in MEMORY.md; register any guard-direction constants
  (inert); update `.claude/handoff.local.md` (note the quality capstone is now unblocked).

## Verification (every step)

`npm run build` (standalone, check `$?` — never pipe to tail/grep, it masks the exit), then `npm test`,
then `npm run lint`. All green before ticking a box or committing. Commit per verified step on
`build/phase-3-generalize-search`.

## Out of scope (recorded, not faked)

- **`quality` / `vision_match`** — the capstone this unblocks; still its own phase (judge→STOP or a
  ground-truth rubric ride on this cost surface). Not built here.
- **Moving category/question scenarios INTO the search corpus** — now *possible* (the cost is modeled)
  but a separate decision with its own guard/spread analysis; keystone-only stays the default invariant.
- **A per-reason DISTINCT cost magnitude / a couple-attention budget cap** — start with one constant;
  differentiated magnitudes are a scenario-authoring refinement, not a forge surface.
