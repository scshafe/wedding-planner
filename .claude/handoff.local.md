# Handoff

## Where things stand — Phase 4a (the tier-2 promotion gate) is BUILT ✅
`.claude/plans/2026-06-24-phase-4a-tier2-promotion-gate.md` is **complete — all 6 steps ticked**, on
branch **`build/phase-3-generalize-search`** (Phase 4a builds directly on the Phase-3 review artifact;
the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**210 tests**, up from 183 at the start of this
run). `main` contains Phase 1 + Phase 2; this branch is the review artifact for Phase 3 **and** Phase 4a.

**What changed:** the firewall's tier-2 human-gate went from documented-but-dormant (zero code
consumers) to **load-bearing**. Before, the loop's only promotion seam was unconditional — a tier-2
genome that honestly declared tier 2 auto-ratcheted the champion, i.e. the autonomous loop granting
itself tier-2 autonomy (the rail breach the safety model forbids). Now the loop **parks** accepted
tier-2 candidates pending an **exogenous** human approval it cannot mint.

### Why this is 4a, not the escalation phase the prior handoff recommended
The prior handoff recommended "the tier-2 escalate-to-couple knob as its own gated phase." Two
adversarial design reviews (specialists not provisioned here — commit b1201fa; ran `general-purpose`
reviewers, plus an adversarial review of the *implemented* gate) **converged on splitting** it: the
tier-2 **gate** is a loop/safety concern needing zero new search dimensions / simulator / forge surface,
and folding escalation into the autonomous search box would contradict committed memory
([[second-genome-knob-must-stay-tier1]] — "never folded into the autonomous search"). So **4a = the
gate** (this run); **4b = the escalate-to-couple knob + forge-detection** (next).

### What's new this phase (by step)
- **Step 1** — `autonomy_threshold` (int 1..3), the first **tier-2** genome knob, mapped to
  `commitment_autonomy`. **OPTIONAL** by presence (no 0='off' value ⇒ no absent-vs-disabled alias, **no
  genome-hash re-baseline**); the autonomous search never emits it (stays tier-1), so it derives tier-2
  only for *injected* candidates. Stage-A wiring + forge-detection deferred to 4b.
- **Step 2** — `pipeline/promotion_gate.ts`: the seam re-derives the tier from the content-addressed
  genome (never the declared `risk_tier`); `tier ≤ 1` lands, `tier ≥ 2` routes to `human_review`. The
  loop outcome is now three-way (`promoted`/`parked`/`human_rejected`); only a landed promotion un-dries
  the search. Promotions are now tamper-evidently ledgered (`offline_passed → promoted`).
- **Step 3** — `pipeline/landing_approval.ts`: the EXOGENOUS, read-only `ApprovalStore` (the loop has no
  approval constructor) + `landingKeyFor = sha256(genome_hash ‖ champion_hash)`, re-derived at the seam.
  approved:true ⇒ land (decided_by human); approved:false ⇒ `human_rejected`; no/stale/wrong-genome
  match ⇒ park. One-shot via `markSpent`. First live consumer of `oversight_record.human_gate`.
- **Step 4** — the **non-self-approval rail**: a source scan asserts no production file authors a
  `human_gate`/`reviewed_by:'human'` literal; `ApprovalStore`'s surface is exactly `{find, markSpent}`.
- **Step 5** — the keystone (`tier2_gate_keystone.test.ts`): the RED/GREEN proof in one fact —
  `accepted === 1` (a naive loop would land it) but `promoted === 0` / `parked === 1`. Plus
  land-with-approval, reject-on-false, and under-declared-tier-2 rejected at the pre-score firewall.
- **Step 6** — `docs/adr/0003`, two memory files, this handoff. **Plus** (from the implemented-gate
  review, no P0s) two contract-hardening fixes: a schema `allOf` making `human_gate ⟹ reviewed_by:human`
  a contract invariant, and an accurate `binds_landing_key` description.

## Next action — Phase 4b (your call, recommended): the escalate-to-couple knob + forge-detection
This is the sanctioned escalation phase ([[second-genome-knob-must-stay-tier1]] update). It makes the
firewall's **integrity forge-detection** load-bearing (4a made the human-gate load-bearing). Wire the
`autonomy_threshold`/escalation knob into Stage A, with Stage B independently observing couple-response
ground truth and the integrity gate covering the new forge surface. **The headline P0 (from the security
review):** `offline_scorer` scores the **CLAIMED** event stream — a forged couple-resolution must be
tied back to a TRUSTED record, not just a new escalation effect-kind, or a product could lie its way to
a higher North Star. And **before** tier-2 enters the autonomous *search*, redefine `converged` as "no
PROMOTABLE point" ([[search-convergence-certificate-semantics]] §4) — a parked-but-acceptable point must
not falsely certify convergence.

Alternative phases (also in-rails): a 3rd tier-1 knob to stress the search at higher dimension; or the
real Claude-Agent-SDK proposer (needs API credentials → STOP-and-surface, the local-only rail).

## Non-obvious Phase-4a context (carry forward)
- **The gate's load-bearing rail: the loop NEVER mints its own approval.** Approvals are exogenous
  read-only input; absent ⇒ park. In real autonomous runs no approvals are supplied, so every tier-2
  candidate parks — safe. See [[tier2-promotion-gate-is-load-bearing]].
- **Two independent, fail-closed tier derivations:** the pre-score reconciliation (rejects
  under-declaration before scoring) AND the promotion seam (re-derives from content at land time). A
  `risk_tier` forged to 1 over a tier-2 genome is caught by both.
- **The landing key binds (genome, champion).** A champion ratchet invalidates a stale approval (it must
  be re-reviewed against the new baseline). `candidate_id` is the wrong key.
- **Prod hardening deferred (recorded, not faked):** L4 key custody (a loop-forged `reviewed_by:human`
  record must fail signature verification, `INTEGRITY.FORGED_CLEAR`). Offline, the structural
  no-constructor rail stands in — consistent with [[prod-trusted-evidence-channel]].
- **Residual audited items (deferred):** `ApprovalStore` last-wins on a duplicate landing key (flag at
  construction later); crash-recovery replay must re-derive the landing key against the *original*
  champion when that phase is wired.
- **`npm run build` is still `tsc --noEmit`** (strict typecheck, no emit). No deployable runtime yet.
- Durable facts: `MEMORY.md` index — Phase-4a added **[[tier2-promotion-gate-is-load-bearing]]** and a
  §4 deferred-fix to **[[search-convergence-certificate-semantics]]**; still load-bearing:
  [[second-genome-knob-must-stay-tier1]], [[genome-content-address-firewall]],
  [[loop-trusted-evidence-boundary]], [[integrity-gate-completeness-invariants]],
  [[accept-rule-composition-invariance]].
