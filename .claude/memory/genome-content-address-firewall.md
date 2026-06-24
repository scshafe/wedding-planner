---
name: genome-content-address-firewall
description: "Phase-2 firewall principle — content-address the strategy genome so the candidate commits to exactly the thing that runs, and re-derive risk independently"
metadata: 
  node_type: memory
  type: project
  originSessionId: 711d4778-e08d-4918-b5dc-dcb363e0ef1a
---

Phase 2 (the planner-simulator substrate) extended the trusted-evidence boundary to the proposer's
output. The firewall must cover **the thing that actually changes behavior**, not just a reviewed
label. Two load-bearing decisions (from doddy's reviews), now in code:

- **Content-address the genome.** A candidate's `change.artifact_ref = "genome:" + sha256(canonicalJson(parameters))`
  (hash over `parameters` only — `genome_id` is behaviorally inert). The simulator/gate re-resolves
  the genome and refuses to run on a `mismatch`/`malformed_ref` verdict (refuse-and-halt, never
  "regenerate the ref"). This closes the "reviewed the label, ran a different genome" seam.
- **Validate-before-bind, fail-closed.** Every enforcement caller `assertValidGenome`s before
  hashing/matching/risk-tiering. `deriveRiskTier` derives the authoritative tier from the genome's
  parameters via a trusted param→surface map (the genome analogue of `risk_tier_derivation.md`,
  doc-only before Phase 2); the reconciliation gate **re-derives** from the content-addressed genome
  and rejects under-declaration — it never trusts the proposer's declared `risk_tier` number.

Also decided: a single-author simulator makes `INTEGRITY.SELF_REPORT_DIVERGENCE` vacuous, so the
simulator is split into **Stage A (planner → claims)** and **Stage B (harness → trusted record from
persona ground truth, never from Stage A)** — the offline embodiment of the
[[prod-trusted-evidence-channel]] feed-path invariant. Builds on [[loop-trusted-evidence-boundary]]
and [[integrity-gate-completeness-invariants]].
