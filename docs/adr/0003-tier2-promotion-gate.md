# ADR 0003 — Make the tier-2 human-gate load-bearing (the promotion gate)

- **Status:** accepted
- **Date:** 2026-06-24
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-24-phase-4a-tier2-promotion-gate.md`)
- **Scope:** Phase 4a — the offline loop's promotion seam only. Offline-first, deterministic, no
  production blast radius. North Star weights and the simulator are **untouched** (no new dynamics).
- **Supersedes nothing.** It SEQUENCES the escalation work that [[second-genome-knob-must-stay-tier1]]
  deferred: 4a is the gate; 4b is the escalate-to-couple knob + forge-detection.

## Context

Before this phase the firewall's tier-2 human gate was documented-but-dormant: `oversight_record.human_gate`
had **zero code consumers**, and the loop's only promotion seam (`offline_loop` `onAccepted` →
`championStore.promote`) was **unconditional** — any candidate that passed the offline accept rule
auto-ratcheted the champion. A tier-2 genome (one touching the `commitment_autonomy` surface — the AI
deciding to act on the couple's behalf without asking) that honestly declared tier 2 would promote
itself: the autonomous loop granting **itself** tier-2 autonomy, the exact rail breach the safety model
forbids (a Tier-2 action requires human approval before it lands).

The handoff recommended building "the tier-2 escalate-to-couple knob as its own gated phase." Two
adversarial design reviews ran before implementation (the repo's specialist sub-agents are not
provisioned here, see commit b1201fa; reviews via `general-purpose` adversarial reviewers, plus an
adversarial review of the implemented gate). They converged on **splitting** that into the gate (4a) and
the escalation knob (4b), and surfaced the gate's safety mechanics. Their findings shaped every decision.

## Decisions

### D1 — SPLIT: 4a is the gate; escalation + forge-detection is 4b

The tier-2 **gate** is a loop/safety concern; it needs **zero** new search dimensions, **zero** new
simulator dynamics, and **zero** forge surface to be made load-bearing. Folding escalation into the
genome as a 3rd search knob would contradict [[second-genome-knob-must-stay-tier1]] ("escalation … as
its own gated phase, **never folded into the autonomous search**") and waste ~75% of autonomous
iterations proposing candidates the loop is structurally forbidden to promote. So 4a makes the gate
load-bearing, proven with an **injected** tier-2 candidate.

### D2 — the tier-2 vehicle is an OPTIONAL, presently-UNWIRED genome knob `autonomy_threshold` (int 1..3)

Mapped to `commitment_autonomy` (tier-2). It is **optional** (not in the schema's `required` set), so the
autonomous search box stays the tier-1 2-D box (cadence × spacing) and `deriveRiskTier` returns 1 for
every genome the search emits (it iterates only *present* parameters); a genome that *carries* the knob
derives to tier-2. Its range is **1..3 with no 0='off' value**, so a genome either omits it (the
canonical tier-1 form) or carries an elevated value — no behavior-equal/hash-distinct absent-vs-disabled
alias, and **no genome-hash re-baseline**. Its Stage-A behavioral wiring + forge-detection are deferred
to 4b (the "decide the tier before the knob is wired" pattern the reserved-surface comments endorse); the
knob exists in 4a only so a tier-2 genome is constructible to exercise the gate.

### D3 — the gate reads the INDEPENDENTLY DERIVED tier at the seam, never the declared number

`runPromotionGate` re-resolves the genome from its content-addressed `artifact_ref` and re-derives the
tier with `deriveRiskTier` *inside* the promotion path. `tier ≤ 1` auto-promotes; `tier ≥ 2` routes to
`human_review`. The pre-score under-declaration reject (`risk_tier_reconciliation`) stays, but is
necessary-not-sufficient — the seam re-derives independently, so a candidate whose `risk_tier` field is
forged down to 1 over a tier-2 genome still parks. Two independent, fail-closed derivations.

### D4 — approvals are EXOGENOUS, read-only injected input; the loop has no constructor for one

This is what makes "absent ⇒ park" an honest model of a human gate in an offline system with no
humans/production. The loop receives `approvals: readonly OversightRecord[]`; the `ApprovalStore` only
READS (`find`) and records consumption (`markSpent`). In real autonomous operation no approvals are
supplied → every tier-2 candidate parks → safe. We do not fake a human; we model "no human approved, so
it does not land." Structural guards: a source scan asserts no production file authors a
`human_gate`/`reviewed_by:'human'` literal; the store's surface is exactly `{find, markSpent}`. The
production hardening is L4 key custody (a loop-forged `reviewed_by:human` record fails signature
verification — `INTEGRITY.FORGED_CLEAR`); offline, the structural rail is the honest stand-in. A schema
`allOf` now makes `human_gate ⟹ reviewed_by:human` a contract invariant, not just a runtime check.

### D5 — the landing key binds `(genome_hash, champion_hash_at_promotion)`, re-derived at spend time

`landingKeyFor = sha256(canonicalJson{genome_hash, champion_hash})`, re-derived at the seam from the
**current** champion + the content-addressed candidate genome. So an approval reviewed against champion A
does not promote after the champion ratchets to B (key mismatch ⇒ park ⇒ re-review against the new
baseline); an approval for genome G cannot promote a different genome; one approval authorizes one
landing (`markSpent`, defense-in-depth above the key). `candidate_id` is deliberately NOT in the key — it
is a per-proposal, content-free id that loses which genome and which baseline the human actually reviewed.

### D6 — the loop outcome is THREE-WAY: `promoted` / `parked` / `human_rejected`

`approved:true` + matching key ⇒ promote (`human_review → promoted`, decided_by `human`). `approved:false`
+ matching key ⇒ reject (`human_review → human_rejected`, disposition `rejected_human`) — terminal, NOT
parked-for-retry (a later stray approval can't resurrect it). No matching approval ⇒ park
(`offline_passed → human_review → parked`, decided_by `deterministic_selector`). Only a landed promotion
un-dries the search; a parked/rejected accept makes no champion progress (it does not reset the dry
counter), so a stream of un-landable tier-2 accepts cannot mask convergence. The convergence certificate
is **unchanged in 4a** because the autonomous search stays on the tier-1 box and never parks mid-sweep.

## Consequences

- The dormant `oversight_record.human_gate` has its **first live consumer**; the `human_review` / `parked`
  / `human_rejected` states and the `rejected_human` / `parked` dispositions are now exercised. Promotions
  are tamper-evidently ledgered (`offline_passed → promoted`), where before only a lineage lesson recorded
  a ratchet.
- The autonomous loop provably cannot land a tier-2 genome without an exogenous approval (keystone:
  `accepted === 1` but `promoted === 0` / `parked === 1` — RED on a naive loop, GREEN on the gated loop).
- **Deferred to 4b** ([[search-convergence-certificate-semantics]] must be revised first): if tier-2 ever
  enters the *search*, `converged` must be redefined as "no **promotable** point against the standing
  champion" — a parked-but-acceptable point is acceptable-not-promotable and must not falsely certify
  convergence. And the escalation forge surface needs the metric-reads-claims seam closed
  (`offline_scorer` scores the CLAIMED event stream; a forged couple-resolution must be tied back to a
  trusted record, not just an escalation effect-kind).
- Residual (deferred, audited): the `ApprovalStore` last-wins on a duplicate landing key (flag at
  construction later); crash-recovery replay must re-derive the landing key against the *original*
  champion when that phase is wired.
