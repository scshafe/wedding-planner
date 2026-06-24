# Handoff

## Where things stand — Phase 3 (generalize the search) is BUILT ✅
`.claude/plans/2026-06-24-phase-3-generalize-the-search.md` is **complete — all 7 steps ticked**, on
branch **`build/phase-3-generalize-search`** (8 commits this run). Working tree clean.
`npm run build && npm test && npm run lint` all green (**183 tests**, up from 166 at the start of this
run / 167 after the schema change). `main` already contains Phase 1 + Phase 2 (merged); this branch is
the review artifact for Phase 3 (the loop's merge-keeper advances `main` when green).

**What changed:** the offline search went from a **1-D** genome with a toy search (axis-aligned
distance-1 + global tabu, one `proposer_exhausted` terminal state) to a **2-D, non-separable** genome
with a real box search and an honest termination taxonomy.

### What's new this phase (by step)
- **Step 1** — `reminder_spacing` (int 0..3), the 2nd genome knob, **REQUIRED** in the closed schema,
  mapped tier-1 (`planning_flow_orchestration`, the temporal twin of cadence). `deriveRiskTier`
  `perParameter` now sorted (stable ledger artifact). All genome fixtures re-baselined for 2 params.
- **Step 2** — Stage A reads spacing: `delivered = min(cadence, capacity(spacing))` (downside: fewer
  nudges fit) + gentler nags with spacing (upside) → a **multiplicative** sentiment interaction.
  **Forge-free** (resolution still from ground truth), so Stage B is unchanged (documented why).
- **Step 3** — the 2-D oracle: anchored spacing values + a **pinned 16-value North-Star matrix** with
  proofs that the optimum is STRICT/UNIQUE/INTERIOR at (cadence 2, spacing 1), the landscape is
  NON-SEPARABLE (argmax cadence depends on spacing), and the box optimum strictly beats every
  spacing-0 point (the old 1-D search can't reach it). Capacity profile tuned to `[3,3,1,0]`.
- **Step 4** — the 2-D `SearchProposer`: fixed champion-independent **spread-first** (bit-reversal /
  van der Corput) box order + **trajectory-relative tabu** (keyed `(championHash, genomeHash)`, so a
  point re-opens after the champion ratchets — fixes the Phase-2 global-tabu miss).
- **Step 5** — the **termination taxonomy**: `converged` (the proposer's `isConverged()` certificate —
  "no ACCEPTABLE point against the standing champion", NOT a global optimum) vs `dry` (stalled) vs
  `budget_exhausted`. Termination guaranteed by the strict North-Star ratchet (bounded promotions, no
  cycle, even with guards).
- **Step 6** — the keystone proof: a `LegacyOneDProposer` fixture (the pre-Phase-3 search) **STALLS at
  (cadence 2, spacing 0)**; the new search reaches **(cadence 2, spacing 1)** on the same landscape
  (RED on old, GREEN on new). Plus spread-coverage-under-truncation and a guard-active termination arm.
- **Step 7** — `docs/adr/0002-generalize-the-offline-search.md`, two memory files, this handoff.

### Design reviews (important context for the next run)
The repo's **specialist sub-agents (wolf, doddy, rigorous-architect, testineer) are NOT provisioned in
this environment** (they live in the operator's `~/.claude`; see commit b1201fa). I substituted **two
`general-purpose` adversarial reviewers** (a search/stats reviewer and an architecture/trust-boundary
reviewer) and folded their P0/P1 findings into the plan as `[R-…]` tags. Their most consequential
catch: the escalate-to-couple knob I first considered is **tier-2 + a forge surface** and would have
broken autonomous operation — which is why the 2nd knob is `reminder_spacing` instead
(`.claude/memory/second-genome-knob-must-stay-tier1.md`). **If you can provision the real specialists,
re-run doddy on the tier-1 classification of `reminder_spacing` and wolf on the search soundness.**

## Next action — pick the next phase (your call)
The autonomous search now generalizes over a real 2-D non-separable landscape with an honest
convergence certificate. Highest-value candidates:
1. **A third tier-1 genome knob** → makes the box ≥3-D and stresses the spread order / certificate at
   higher dimension (cheap, in-rails; the box generator + matrix oracle extend mechanically). Good if
   you want to harden the search further before changing substrate.
2. **The tier-2 escalate-to-couple knob as its OWN gated phase** — the deferred, high-value work that
   makes the firewall's **tier-2 human-gate + integrity forge-detection** load-bearing: Stage B must
   independently observe escalation/resolution, the integrity gate needs an escalation effect kind, and
   the loop must GATE (not auto-promote) tier-2 candidates. Fully offline (simulate the human gate). See
   the rejected-path notes in `stage_b_observer.ts` and `second-genome-knob-must-stay-tier1.md`.
3. **Real Claude-Agent-SDK proposer** — plugs into the SAME `Proposer` interface + genome type.
   **Needs API credentials → STOP-and-surface** (the local-only rail). Do not fake calls.

**Recommend #2** — it is the deferred high-value firewall work, now well-scoped, and it is what turns
the tier-2 + forge-detection machinery from documented-but-dormant into load-bearing.

## Non-obvious Phase-3 context (carry forward)
- **The `converged` certificate is "no ACCEPTABLE point", not "global optimum"** — guards/golden
  conditions can veto a higher-North-Star point. See [[search-convergence-certificate-semantics]].
- **The spread-first order is outcome-neutral under a full sweep** — it only matters under
  `maxIterations` truncation. Don't claim it improves the converged result.
- **At `reminder_spacing = 0` the simulator is byte-identical to Phase 2**, which is why the Phase-2
  anchored-oracle values were preserved unchanged when the knob was added.
- **The interior optimum depends on tuned simulator constants** (capacity `[3,3,1,0]`, relief 0.25),
  pinned by the matrix oracle. North Star **weights are never tuned**. A constant-sensitivity *margin*
  check stands in for an injection-based sensitivity test (constants are module-level, not injected) —
  making them injectable is a possible refinement.
- **`npm run build` is still `tsc --noEmit`** (strict typecheck, no emit). No deployable runtime yet.
- Durable facts: `MEMORY.md` index — Phase-3 added **[[second-genome-knob-must-stay-tier1]]** and
  **[[search-convergence-certificate-semantics]]**; still load-bearing:
  [[genome-content-address-firewall]], [[loop-trusted-evidence-boundary]],
  [[integrity-gate-completeness-invariants]], [[accept-rule-composition-invariance]].
