---
name: loop-trusted-evidence-boundary
description: "The meta-gaming firewall must protect the graders' INPUTS (evidence), not just their code"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6516eb65-8633-4b90-8c13-798200fc27e6
---

The recursive loop's safety firewall walls the proposer off from the grader *code* — but the veto
gates, surprise check, risk-tier derivation, and circuit breakers all read events **the product
emits**, and the product is exactly what the proposer rewrites. So a product-only change can forge
or suppress events to defeat any "untouchable" gate. "A metric is a pure function over events" is a
*determinism* guarantee, not an *integrity* one.

Therefore: security-relevant ground truth (spend committed, integration confirmed, constraint/fact
correctness) is authored by **channels the product cannot forge** — the harness's out-of-band
**trusted recorder** (interception of actual sandboxed effects) and **grader-side** determinations
from persona ground truth — never product-set fields. Product self-reports are kept as *claims*,
cross-checked against the trusted record; divergence is itself a veto failure
(`INTEGRITY.SELF_REPORT_DIVERGENCE`). Related: risk_tier derives from the diff not self-declaration;
circuit breakers read out-of-band signals (payment processor, vendor confirmations, complaints);
the ledger is a hash-chained WORM log outside the proposer's write scope.

**Why:** surfaced by a 3-specialist adversarial review (security/stats/architecture) of the
[[north-star-objective]] loop design; this was the single finding all three circled. It reshaped
the telemetry + gate_checks + safety_and_governance specs.

**How to apply:** fields tagged `TRUSTED-AUTHORED` in `telemetry/schemas/event_payloads_schema.json`
must never be product-written. Any new gate or metric that gates a decision must name its trusted
input. All review fixes are now applied — P0 (trust boundary), P1 (cluster randomization for
shared-vendor SUTVA, online FDR vs Benjamini-Hochberg, surrogate validation, MDE/power/τ², sequential
vs hard-veto breakers), and P2 (stage-machine, crash recovery, naming/validation/PII). Governed
alongside [[spend-autonomy-model]] and [[agent-run-operations-model]].
