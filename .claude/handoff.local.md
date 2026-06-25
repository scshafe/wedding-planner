# Handoff

## Where things stand — Phase 7 (trusted Q&A reconciliation) is BUILT ✅
`.claude/plans/2026-06-24-phase-7-qa-accuracy-trusted-reconciliation.md` is **complete — all steps ticked**
(Step 0 design review + Steps 1–9), on branch **`build/phase-3-generalize-search`** (the open review
artifact for `main`; Phases 3/4a/4b/5/6/7 build on it; the loop's merge-keeper advances `main` when green).
Working tree clean. `npm run build && npm test && npm run lint` all green (**298 tests**, up from 263 at
the start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases 3, 4a, 4b, 5, 6 **and 7**.

**What changed:** `qa_accuracy_rate` (a third of the `completeness` North-Star component) went from
**unimplemented/claimed-only** to **trusted-backed**. The integrity firewall gained a **6th reconciled
effect kind (`qa_outcome`)**: Stage A emits one `guest.question.answered` per scripted question, Stage B
authors one trusted Q&A outcome per question, and the gate reconciles BOTH claimed fields the metric reads
(`action_taken`, `answerable_by_expected`). **MILESTONE: every computed North-Star input is now
trusted-backed except `quality`** (honestly deferred — judge → STOP rail; stub → fabrication rail). Honest
runs on the existing (question-free) corpus are byte-identical — purely firewall hardening + a new
trusted-backed signal. See `docs/adr/0007`.

### The load-bearing insight (carry forward — easy to get wrong)
A naïve Q&A model (honest planner always correct) makes the gate **VACUOUS** (honest qa pinned at 1.0,
nothing to forge *up*). It is load-bearing ONLY because **Q&A competence is genome-dependent via the
EXISTING tier-2 `autonomy_threshold`**: a `requires_couple` question is handled correctly only by
ESCALATING (consumes couple attention = the `commitment_autonomy` tier-2 surface), so a **tier-1** genome
honestly ANSWERS it (incorrect, qa < 1.0). No new search knob; the search corpus stays question-free so the
cube/matrix pins are unchanged. Encoded in the SHARED fact `honestQaAction(answerable_by, canEscalate)`;
the grader oracle `requiredQaAction` lives in **telemetry** (base layer) so correctness has ONE definition.

### What's new this phase (by step)
- **Step 1** — `requiredQaAction` (telemetry `metrics/qa_grading.ts`) + `honestQaAction` (eval-harness
  `domain_facts.ts`). Tier-gated: requires_couple+tier-1 → `answered` (the only honest≠required case).
- **Step 2** — `TrustedQaOutcomeRecord {guest_id, question_id, answerable_by, action_taken}` + recorder
  methods, keyed by a printable composite key (`JSON.stringify([guestId, questionId])` — NOT a NUL byte).
- **Step 3** — tolerant `readGuestQuestionAnsweredPayload` + claims-only `qaAccuracyRate` metric;
  `metric_catalog.md` reconciled to the claims-only formula.
- **Step 4/5** — Stage A emits, Stage B records (one per question, from the trusted genome's canEscalate);
  agreement sweep pins trusted == honest claim across answerable_by × tier.
- **Step 6** — gate's 6th effect kind `qa_outcome` (forged/duplicate, field_mismatch on both fields,
  suppressed). **doddy** APPROVE-WITH-CHANGES applied (tolerant ids, read-seam invariant test).
- **Step 8** — keystone `qa_forge_keystone.test.ts`: tier-1-vs-tier-1, 4 forge arms (escalate-claim,
  relabel, suppress, duplicate) each strictly raise qa and STRICTLY win absent the gate
  (`forgeWouldWinAbsentGate` counterfactual) but are vetoed. **wolf** REJECTED the original
  tier-1-vs-tier-2 framing (no QA-escalation cost → only a tie); **testineer** required the counterfactual
  (a veto zeroes the ratio, over-determining `accepted=false`).
- **Step 9** — `docs/adr/0007` + memory [[qa-accuracy-trusted-reconciliation]] + updated
  [[tier2-promotion-gate-is-load-bearing]] + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **`quality` North-Star component** (weight 0.4, still `null`) — the LARGEST unbuilt VALUE lever and now
  the ONLY non-trusted-backed computed input. Needs a real Claude judge → **API credentials → STOP-and-
  surface** (offline-first rail), OR a deterministic stub rubric (brushes "don't fabricate" + adds a NEW
  unbacked claimed-only forge surface). Do NOT build the stub silently; design an offline-legitimate rubric
  first (e.g. a deterministic ground-truth-derived rubric over the booked plan, reconciled like qa/sentiment)
  or STOP. This is the natural capstone of the "all inputs trusted-backed" arc.
- **`category_completeness_rate`** (the 3rd completeness metric, still unimplemented) — needs a small
  plan-state simulator model (which categories the genome books vs the couple's required set), then the same
  reconciliation pattern. Fully offline, lower value than quality but a clean continuation.
- **Model + reconcile a QA-escalation couple cost** — would let the Q&A keystone use a literal tier-2
  champion (a tier-1 forging tier-2-grade handling to dodge the couple cost). Conflicts with the
  one-couple-session-per-guest RSVP-escalation key (needs a per-(guest,reason) session key). Small,
  hardening-flavored; closes the deferral wolf flagged.
- **Back-port the `forgeWouldWinAbsentGate` counterfactual to the Phase-6 sentiment keystone** — testineer
  noted it shares the same `accepted=false` over-determination. Low-effort test hardening.
- **A 4th tier-1 knob → 4-D search** — more search generalization; lower marginal value than closing the
  value-component gaps above. Needs per-guest receptivity ground truth (ADR 0005 alts).

## Non-obvious Phase-7 context (carry forward)
- **Reconciling `answerable_by_expected` is load-bearing** — the metric reads it, so a relabel forge
  (call a couple-question AI-answerable) scores correct unless the gate diffs it. Diffing `action_taken`
  alone is insufficient.
- **The metric reader is fully tolerant** (enum-or-null, ids included) so an adversarial/malformed claim
  scores conservatively + is gate-vetoed, NEVER crashes scoring (which runs metrics even after a gate
  fails). The gate keeps its OWN raw read; a read-seam invariant test guards the two-reader agreement.
- **Question-bearing scenarios are KEYSTONE-ONLY — never in the search corpus.** Q&A is null in
  question-free scenarios (cube pins intact); a tier-1 search candidate on a question-bearing scenario
  would guard-regress on the qa guard vs a tier-2 champion.
- **A vetoed run zeroes the North-Star ratio**, so `accepted=false` is over-determined (it trips the
  golden + aggregate conditions too). To prove the gate is the SOLE stopper, assert a counterfactual: the
  candidate's UN-vetoed aggregate strictly beats the champion. (Applies to every forge keystone.)
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&` — the
  pipe masks the build's non-zero exit. Run build standalone and check `$?`.
- **Do not embed a literal NUL byte in a TS source file** (it makes the file binary; git flags it Bin and
  tooling chokes). Use a printable collision-free composite key (JSON.stringify of a tuple).
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run did,
  for all four: architect at design, doddy+wolf at the gate, testineer at the keystone).
- Durable facts: `MEMORY.md` index — Phase 7 added **[[qa-accuracy-trusted-reconciliation]]** and updated
  [[tier2-promotion-gate-is-load-bearing]]. Still load-bearing: [[sentiment-trusted-reconciliation]],
  [[escalation-forge-detection-load-bearing]], [[tier2-promotion-gate-is-load-bearing]],
  [[genome-content-address-firewall]], [[loop-trusted-evidence-boundary]],
  [[integrity-gate-completeness-invariants]], [[accept-rule-composition-invariance]],
  [[second-genome-knob-must-stay-tier1]], [[search-convergence-certificate-semantics]],
  [[third-tier1-knob-batching-3d-search]].
