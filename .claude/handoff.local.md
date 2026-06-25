# Handoff

## Where things stand — Phase 8 (trusted category-completeness) is BUILT ✅
`.claude/plans/2026-06-25-phase-8-category-completeness-trusted-reconciliation.md` is **complete — all steps
ticked** (Step 0 design review + Steps 1–9), on branch **`build/phase-3-generalize-search`** (the open review
artifact for `main`; Phases 3/4a/4b/5/6/7/8 build on it; the loop's merge-keeper advances `main` when green).
Working tree clean. `npm run build && npm test && npm run lint` all green (**330 tests**, up from 298 at the
start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases 3, 4a, 4b, 5, 6, 7 **and 8**.

**What changed:** `category_completeness_rate` (the 3rd `completeness` North-Star input) went from
**unimplemented/claimed-only** to **trusted-backed**. The integrity firewall gained a **7th reconciled effect
kind (`category_booking`)** — and the **FIRST plan-side model** (every prior phase modeled guest interactions;
this models the PLAN: which categories the couple needs vs which the planner books). Stage A emits one
`category.booked` per required category, Stage B authors one trusted booking, and the gate reconciles the one
metric field (`booking_status`) + the join key (`category_id`). **MILESTONE: the completeness trilogy is
complete — all three completeness inputs (rsvp/qa/category) are trusted-backed, so every computed North-Star
input is trusted-backed EXCEPT `quality`** (still deferred). Honest runs on the existing (category-free) corpus
are byte-identical — purely firewall hardening + a new trusted-backed signal. See `docs/adr/0008`.

### The load-bearing insight (carry forward — same shape as Phase 7)
A naïve booking model (honest planner books everything) makes the gate **VACUOUS** (honest rate pinned at 1.0,
nothing to forge up). It is load-bearing ONLY because **booking competence is genome-dependent via the EXISTING
tier-2 `autonomy_threshold`** — the SAME `commitment_autonomy` surface Q&A escalation uses: a
`requires_couple_approval` category is booked correctly only by ESCALATING for the couple's commitment-authority,
so a **tier-1** genome honestly `deferred`s it (rate < 1.0). No new search knob; category-bearing scenarios are
**KEYSTONE-ONLY** (the cube/matrix pins are unchanged). Shared fact
`honestCategoryStatus(requiresCoupleApproval, canEscalate)`; NO grader oracle (correctness is just
`status==='booked'`, a deliberate asymmetry from Q&A). Encoded in memory
[[category-completeness-trusted-reconciliation]].

### What's new this phase (by step)
- **Step 1** — `CategoryBookingStatus = 'booked'|'deferred'` (telemetry payload vocabulary, no oracle module) +
  tolerant `readCategoryBookedPayload` + `honestCategoryStatus` shared fact.
- **Step 2** — optional `required_categories` on the runtime `ScenarioDefinition` (the `bookedPlanFacts`
  precedent — NOT a JSON Schema; makes keystone-only structural, no contract regen). **architect P1-A.**
- **Step 3** — claims-only `categoryCompletenessRate` metric; `metric_catalog.md` reconciled (lead-time clause
  struck, paired-gate column corrected). **architect P1-B.**
- **Step 4** — `TrustedCategoryBookingRecord` + recorder API (first plan-side trusted record).
- **Step 5** — Stage A emits, Stage B records (one per required category, shared fact); byte-identity asserted
  directly (zero category events/records on the category-free corpus).
- **Step 6** — gate's 7th effect kind `category_booking` (join key defends denominator: forged/duplicate/
  suppressed; `booking_status` defends numerator: field_mismatch). **doddy** APPROVE-WITH-CHANGES (NO bypass
  across the reader-seam cross-product; pinned the load-bearing field set).
- **Step 7** — honest-run audit clean across approval × tier (a stage divergence on the tier-1 deferred category
  would self-veto every honest tier-1 run).
- **Step 8** — keystone `category_forge_keystone.test.ts`: tier-1-vs-tier-1, 3 forge arms (claim booked,
  duplicate, suppress) each strictly raise the rate + STRICTLY win absent the gate (`forgeWouldWinAbsentGate`)
  but are vetoed. **testineer** APPROVE-WITH-CHANGES (verified gate-load-bearing; added `onlyIntegrityFailed`).
- **Step 9** — `docs/adr/0008` + memory [[category-completeness-trusted-reconciliation]] + registered the guard
  direction (inert) + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **`quality` North-Star component** (weight 0.4, still `null`) — the LARGEST unbuilt VALUE lever and now the
  ONLY non-trusted-backed computed input. Needs a real Claude judge → **API credentials → STOP-and-surface**
  (offline-first rail), OR a deterministic stub (fabrication rail). Do NOT build the stub silently; design an
  offline-legitimate **ground-truth-derived rubric over the booked plan** first (now feasible — Phase 8 built
  the first plan-side model: `required_categories` + booked/deferred status are real plan state a deterministic
  vision-match-style rubric could score against the couple's `vision`/`budget.category_priorities` ground truth,
  reconciled like qa/category), or STOP. This is the natural capstone of the "all inputs trusted-backed" arc.
- **Model + reconcile a booking-approval / QA-escalation couple COST** — would let a category (or Q&A) keystone
  use a literal tier-2 champion (a tier-1 forging tier-2-grade handling to dodge the couple cost). Needs a
  per-(guest/category, reason) session key (the one-couple-session-per-guest RSVP key currently collides).
  Small, hardening-flavored; closes the deferral both Phase 7 and Phase 8 flagged as ONE constraint.
- **Back-port `forgeWouldWinAbsentGate` + `onlyIntegrityFailed`** to the Phase-6 sentiment keystone — low-effort
  test hardening (the Q&A keystone could also gain `onlyIntegrityFailed`).
- **A 4th tier-1 knob → 4-D search** — more search generalization; lower marginal value than closing the
  `quality` value-component gap. Needs per-guest receptivity ground truth (ADR 0005 alts).

## Non-obvious Phase-8 context (carry forward)
- **Ground truth on the runtime `ScenarioDefinition`, not a JSON Schema** (the `bookedPlanFacts` precedent) —
  this is WHY keystone-only is structural, not just disciplined. A future LLM-role-player phase that needs
  categories in a contract should add it THEN.
- **The metric reads ONLY `category_id` + `booking_status`** — `category` is provenance (unread) and
  `requires_couple_approval` is trusted-internal (never claimed), so there is NO relabel surface and only one
  field is diffed (leaner than Q&A's two). A test pins this load-bearing field set; if a future grader reads
  `category`, it becomes an un-diffed relabel field — add it to the gate diff then.
- **The deferred booking-approval cost ⇔ the keystone-only invariant are the SAME constraint** — don't put
  category-bearing scenarios in the search corpus until the cost is modeled (a tier-2 genome would get a free
  completeness gain). Documented in ADR 0008 Out-of-scope + memory.
- **A vetoed run zeroes the North-Star ratio**, so `accepted=false` is over-determined; the forge keystones
  assert `forgeWouldWinAbsentGate` (counterfactual) AND now `onlyIntegrityFailed` (INTEGRITY is the SOLE new
  gate failure) to isolate the gate as the real stopper.
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&` — the pipe
  masks the build's non-zero exit. Run build standalone and check `$?`.
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here —
  route adversarial reviews through `general-purpose` agents carrying the persona lens (this run did, for
  architect at design, doddy at the gate, testineer at the keystone).
- Durable facts: `MEMORY.md` index — Phase 8 added **[[category-completeness-trusted-reconciliation]]**. Still
  load-bearing: [[qa-accuracy-trusted-reconciliation]], [[sentiment-trusted-reconciliation]],
  [[escalation-forge-detection-load-bearing]], [[tier2-promotion-gate-is-load-bearing]],
  [[genome-content-address-firewall]], [[loop-trusted-evidence-boundary]],
  [[integrity-gate-completeness-invariants]], [[accept-rule-composition-invariance]],
  [[second-genome-knob-must-stay-tier1]], [[search-convergence-certificate-semantics]],
  [[third-tier1-knob-batching-3d-search]].
