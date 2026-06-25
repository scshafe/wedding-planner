---
name: tier2-promotion-gate-is-load-bearing
description: "Phase-4a: how the loop gates tier-2 candidates — exogenous read-only approval, landing key binds (genome,champion) re-derived at the seam, derived-tier (never declared), absent=>park / approved:false=>reject; the loop has no approval constructor"
metadata:
  node_type: memory
  type: project
---

Phase 4a turned the firewall's tier-2 human-gate from documented-but-dormant into LOAD-BEARING. Before
it, the loop's only promotion seam was unconditional: any accepted candidate auto-ratcheted the champion,
so a tier-2 genome that honestly declared tier 2 promoted itself — the autonomous loop granting ITSELF
tier-2 autonomy (the rail breach [[second-genome-knob-must-stay-tier1]] warns about). The gate
(`loop-orchestrator/src/pipeline/promotion_gate.ts` + `landing_approval.ts`) closes it. Load-bearing,
non-obvious invariants:

1. **The loop NEVER mints its own tier-2 approval.** Approvals are exogenous `readonly OversightRecord[]`
   injected into the loop; the `ApprovalStore` only READS (`find`) and records consumption (`markSpent`)
   — it has no constructor for an approval. In real autonomous operation no approvals are supplied ⇒
   every tier-2 candidate PARKS ⇒ safe. This is honest, not faked: we model "no human approved, so it
   does not land", we do not simulate a human. A source-scan test asserts no production file authors a
   `human_gate`/`reviewed_by:'human'` literal; the prod hardening is L4 key custody (a loop-forged human
   record fails signature verification, `INTEGRITY.FORGED_CLEAR`), recorded as future work, consistent
   with [[prod-trusted-evidence-channel]].

2. **Tier is re-derived at the seam from the content-addressed genome, NEVER the declared `risk_tier`.**
   `runPromotionGate` re-resolves the genome from `artifact_ref` and calls `deriveRiskTier`. `tier ≤ 1`
   (MAX_AUTONOMOUS_PROMOTION_TIER) auto-promotes; `tier ≥ 2` routes to `human_review`. The pre-score
   under-declaration reject stays as a sibling, but the seam re-derives independently — two fail-closed
   derivations. A `risk_tier` forged to 1 over a tier-2 genome still parks.

3. **The landing key binds `(genome_hash, champion_hash)`, re-derived at spend time.**
   `landingKeyFor = sha256(canonicalJson{genome_hash, champion_hash})`. So a champion ratchet invalidates
   a stale approval (it would otherwise land a genome against an UNREVIEWED baseline); an approval for one
   genome can't promote another; `markSpent` makes it one-shot. `candidate_id` is the WRONG key (per-
   proposal, content-free — loses which genome/baseline the human reviewed).

4. **Three-way outcome.** approved:true ⇒ promote (decided_by human); approved:false ⇒ `human_rejected`
   (terminal, NOT parked-for-retry); no match ⇒ park (decided_by deterministic_selector). Only a landed
   promotion un-dries the search — a parked/rejected accept makes no champion progress.

The tier-2 vehicle is `autonomy_threshold` (optional genome knob, int 1..3, `commitment_autonomy`).
OPTIONAL by presence (no 0='off' value ⇒ no absent-vs-disabled alias, no hash re-baseline); the
autonomous search never emits it (stays tier-1), so the gate only fires for injected candidates in 4a.
Its Stage-A wiring + forge-detection are Phase 4b. The schema now enforces `human_gate ⟹
reviewed_by:human` as a contract invariant (an `allOf` branch), not just a runtime check. See
docs/adr/0003.

**Phase 7 extended what `autonomy_threshold` GOVERNS:** beyond escalating RSVPs to the couple, its
*presence* now also gates **Q&A escalation** (`canEscalate = autonomy_threshold !== undefined`). A
`requires_couple` guest question is handled correctly only by escalating it to the couple — a
`commitment_autonomy` act — so a tier-1 genome honestly answers it WRONG (qa < 1.0). This is the
genome-dependence that makes `qa_accuracy_rate`'s firewall non-vacuous
([[qa-accuracy-trusted-reconciliation]]). Semantically coherent (autonomy_threshold = "how much the
planner acts via the couple"), and it does NOT change this gate's mechanics — a Q&A-escalating genome is
still tier-2 and still parks. NB: there is no modeled couple *cost* for a Q&A escalation yet (unlike RSVP
escalation's couple session), which is why the Phase-7 keystone is tier-1-vs-tier-1, not vs a tier-2
champion.
