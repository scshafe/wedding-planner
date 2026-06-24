---
name: integrity-gate-completeness-invariants
description: "Two completeness rules the INTEGRITY divergence gate must satisfy so forging/suppressing can't dodge a veto gate"
metadata: 
  node_type: memory
  type: project
  originSessionId: e797abb3-1adc-4d2b-9538-a31f279a8220
---

From doddy's adversarial review of the Phase-1 trusted recorder + `INTEGRITY.SELF_REPORT_DIVERGENCE`
gate (the project's #1 firewall). Two invariants that every future gate (Step 8+ SPEND/BUDGET/
CONSTRAINT/COMMS/INTEGRATION) must preserve, because violating either reopens the meta-gaming hole
even though the headline "gates read trusted, not payload" property holds.

**1. Full-field reconciliation.** The set of fields the integrity gate diffs (product claim vs
trusted record) MUST cover *every* trusted field any veto gate reads. If the integrity gate
reconciled fewer fields than a sibling gate consumes, a product can emit a *self-consistent lie* on
an un-diffed field (e.g. `auto_executed`/`scope_id`/`cost_cents`/`refundable`) that passes the
firewall — the gate's verdict is still correct (it reads trusted), but the audit/Tier-2 packet shows
a coherent false story the firewall certified as non-divergent. Implemented via declared field-diff
lists in `eval-harness/src/gates/integrity_gate.ts`; when a new gate keys on a new trusted field, add
it to those lists.

**Why:** [[loop-trusted-evidence-boundary]] says protect the gates' inputs; this says the integrity
gate's *coverage* must equal the gates' input surface, not a subset.
**How to apply:** for each trusted field a new gate reads, add a FieldDiff entry so a divergent claim
on it is itself a veto failure.

**2. Shared reader-set (no channel seam).** "What counts as the product *reporting* an effect" must
be one shared definition (`eval-harness/src/gates/report_event_names.ts`), imported by both the
suppression detector and any gate that reasons about reports. Two readers of one telemetry channel
keying on different event-name sets is a seam: a product reports under a name one reader scans and
the other doesn't, satisfying a gate while staying invisible to suppression. The commitment report
set is the COMPLETE outcome set (executed + auto_executed + failed) so a lie within a report is caught
by the field diff rather than missed by suppression.

**Also (deferred to Phase 2):** the trusted recorder currently trusts its caller absolutely
(`RecordCommitmentInput` carries every trusted field). Sound in Phase 1 (caller IS the sandbox). When
the real interception layer lands, brand the record* input so a product-authored value cannot be
passed by accident — [[prod-trusted-evidence-channel]]. Highest-leverage thing to get right then.
