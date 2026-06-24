# ADR 0004 — Make integrity forge-detection load-bearing (escalate-to-couple + trusted RSVP-outcome reconciliation)

- **Status:** accepted
- **Date:** 2026-06-24
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-24-phase-4b-escalation-forge-detection.md`)
- **Scope:** Phase 4b — the offline planner simulator (Stage A/B) + the integrity gate + the metric→
  trusted backing. Offline-first, deterministic, no production blast radius. North Star **weights** and
  the pinned 16-value tier-1 matrix are **untouched**.
- **Supersedes nothing.** It executes the escalation work [[second-genome-knob-must-stay-tier1]]
  deferred and [[tier2-promotion-gate-is-load-bearing]] (ADR 0003) sequenced: 4a made the human-gate
  load-bearing; 4b makes the integrity gate's forge-detection load-bearing.

## Context

4a left the firewall's integrity gate (`INTEGRITY.SELF_REPORT_DIVERGENCE`) **effectively vacuous in the
live offline loop**: it reconciled only `commitment`/`integration` effects, of which the RSVP model
emits none. Meanwhile the scorer computes every metric over the **CLAIMED** event stream
(`offline_scorer.ts`), and RSVP resolution + couple cost had **no trusted backing at all**. So a lying
planner could forge a `guest.rsvp.received` (inflate the `rsvp_resolution_rate` numerator) or under-
report `couple.session.ended` `active_seconds` (deflate the `effort_cost` denominator) and **lie its way
to a higher North Star** unchecked. The handoff named this the headline P0.

The vehicle is the tier-2 `autonomy_threshold` knob (classified in 4a, unwired): an **escalate-to-couple**
behavior that resolves a still-pending guest by consuming the couple's attention — putting a forgeable
claim directly on BOTH the resolution numerator and the couple-cost denominator. Two adversarial design
reviews ran before implementation (the repo's specialist sub-agents are not provisioned here, see commit
b1201fa; reviews via `general-purpose` adversarial reviewers framed as the security/trust-boundary
reviewer and the architecture reviewer). The security review found the naive "reconcile escalation
events" defense had **three live bypasses**; the architecture review (verdict: sound-with-changes)
pinned the A/B independence discipline and the window-free sequencing. Their findings are D2–D7.

## Decisions

### D1 — Escalation is exercised by INJECTED tier-2 candidates ONLY; never folded into the autonomous search
Per [[second-genome-knob-must-stay-tier1]]. The search box stays the tier-1 2-D box (cadence × spacing);
`search_proposer.genomeFor` never emits `autonomy_threshold`. A **box-is-tier-1 guard test** pins this as
a regression-proof invariant (every enumerated box point derives tier 1). Consequence: no parked-but-
acceptable point can arise mid-sweep, so the convergence-certificate redefinition deferred in
[[search-convergence-certificate-semantics]] §4 ("converged = no PROMOTABLE point") **stays deferred** —
it is only needed when a phase actually puts tier-2 in the autonomous search, which this is not.

### D2 — Escalation emits only `couple.session.ended` (cost) + `guest.rsvp.received` (resolution); NO decision events
Confines the new forge surface to exactly the two North-Star-hot metrics. It deliberately emits no
`ai.decision.autonomous` / `couple.decision.*` events, so `autonomy_rate` and `decision_reversal_rate`
(also claimed-event metrics) gain **no** new uncovered forge surface (the security review's P0-4).
Decision-event modeling + its reconciliation is a documented deferral.

### D3 — Reconcile RSVP RESOLUTION as ONE concept keyed on `guest_id`, regardless of cause
The integrity gate reconciles EVERY claimed `guest.rsvp.received` (reminder- OR couple-attributed)
against a trusted per-guest RSVP-outcome record: forged (no trusted resolution), field_mismatch
(`rsvp_status`), suppressed (trusted but unclaimed). This also closes a **pre-existing** hole — a forged
reminder-labeled resolution for a never-responder was previously unreconciled (security review P0-1). The
cause-label is provenance only, never a reconciliation seam.

### D4 — Reconcile couple-cost at FIELD level (`active_seconds`), keyed on the escalated `guest_id`
Suppression-only detection is defeated by *partial* under-reporting (security review P0-2/P0-3). The gate
field-diffs `active_seconds` with `skipWhenClaimAbsent:false` (an absent/non-numeric value against a
positive trusted cost is a mismatch, not a skip), keyed on the escalated `guest_id` carried as
`about_guest_id` (harness-derivable, never a product-chosen opaque id — P1-1), three-way.

### D5 — Stage B takes `(scenario, genome)` but shares only the ground-truth FACT, never the claim path
Stage B reads the trusted, content-addressed, validated genome to know **which policy to evaluate**, and
re-derives the trusted outcome **by its own computation** from `domain_facts.ts` (the shared FACTS:
`REMINDERS_NEEDED`, `spacingCapacity`, couple-resolvability, the escalation budget). It must NEVER import
Stage A's emission/`guestOutcome` path (architecture C2 + security P1-3), or a bug would corrupt both
sides identically and re-vacuum the gate. Independence holds because Stage B still never reads
`productEvents`. **`couple_resolvable` is a SCENARIO persona fact, never a genome field** — the genome
supplies only the escalation policy, so a genome cannot assert a guest resolvable (security P1-4).

### D6 — The new trusted effect family is `couple_resolution` / `rsvp_outcome`, NOT the ops `escalation_record`
`escalation_record_schema.json` is the agent-operations **Tier-3 human-reserved incident** contract — a
different concept (architecture C4). The new trusted types live in `trusted_outcomes.ts`; the new
report-event-name sets live in `report_event_names.ts` (the reader-seam invariant,
[[integrity-gate-completeness-invariants]]). This is the first non-commitment/non-integration trusted
effect family, and the first integrity coverage of a field the North Star numerator/denominator reads.

### D7 — The integrity gate VETOES, it does not correct; the keystone asserts `new_gate_failures` non-empty
The firewall path is: forge → integrity gate fails → accept-rule condition 2 (no NEW gate failure vs
baseline) rejects. The keystone proves, per forge face, that the forge moves the claimed metric
favourably (a claims-trusting loop would reward it) yet `new_gate_failures` is non-empty and the
candidate is rejected. With an honest baseline this is airtight.

## Consequences

- The integrity gate is now **load-bearing in the live loop**: a forged resolution / shaved or
  suppressed couple-cost is a veto, not free score. The metric-reads-claims P0 is closed.
- Two test fixtures that emitted `guest.rsvp.received` without a trusted outcome had to author honest
  outcomes — the firewall correctly biting a previously-tolerated unreconciled claim.
- The autonomous loop still cannot self-grant tier-2 autonomy (the 4a rail is untouched); escalation is
  injected-only and the search box is pinned tier-1.
- **Deferred (recorded, not faked):** decision-event reconciliation (D2); the convergence-certificate
  "no PROMOTABLE point" redefinition (D1) until tier-2 enters the search; production key-custody for the
  trusted feed (the offline single-authorship recorder stands in, per [[prod-trusted-evidence-channel]]).
- `guest_sentiment_score` remains a claimed-only metric with no trusted backing — escalation does not
  touch it, and reconciling model-output metrics is out of scope (documented, like `qa_accuracy_rate`).

## Alternatives considered

- **Reconcile only escalation-attributed resolutions.** Rejected: leaves the reminder-labeled forge open
  (D3) — security review P0-1.
- **Suppression-only couple-cost detection.** Rejected: partial under-reporting bypasses it (D4).
- **A shared resolution-computing function both stages call.** Rejected: re-vacuums the gate and makes
  the lying-genome keystone unconstructible (D5) — share the FACT, not the claim.
- **Fold escalation into the autonomous search now (+ the convergence redefinition).** Rejected:
  contradicts committed memory and is speculative complexity for a path nothing exercises (D1).
