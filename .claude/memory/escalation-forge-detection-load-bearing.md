---
name: escalation-forge-detection-load-bearing
description: "Phase-4b — the integrity gate's forge-detection is now load-bearing in the live loop: every claimed RSVP resolution + couple-cost is reconciled against a trusted record, so a forged couple-resolution / shaved cost can't inflate the North Star; escalate-to-couple is the vehicle, injected-only"
metadata:
  node_type: memory
  type: project
---

Phase 4b made the firewall's **integrity forge-detection** load-bearing (4a did the human-gate). Before
4b, `INTEGRITY.SELF_REPORT_DIVERGENCE` reconciled only `commitment`/`integration` effects — of which the
RSVP model emits NONE — so it was **effectively vacuous in the live offline loop**, while the scorer
computes every metric over the CLAIMED event stream (`offline_scorer.ts`). RSVP resolution and couple
cost had no trusted backing, so a lying planner could forge a resolution or shave the cost and lie its
way to a higher North Star. See ADR 0004 and [[loop-trusted-evidence-boundary]].

**The vehicle: the tier-2 `autonomy_threshold` "escalate-to-couple" knob.** Escalation resolves a still-
pending guest by consuming the couple's attention — putting a forgeable claim on BOTH the
`rsvp_resolution_rate` numerator AND the `couple_active_minutes_total → effort_cost` denominator. It
emits ONLY `couple.session.ended` (cost) + `guest.rsvp.received` (resolution) — deliberately NO decision
events, so `autonomy_rate`/`decision_reversal_rate` gain no uncovered forge surface.

**Load-bearing facts (non-obvious, easy to get wrong):**

1. **Resolution is reconciled as ONE concept keyed on `guest_id`, regardless of cause.** Every claimed
   `guest.rsvp.received` (reminder- OR couple-attributed) is diffed against the trusted RSVP-outcome
   record. A forge labeled "reminder-resolved" inflates the IDENTICAL numerator — an escalation-only
   reconciler would miss it. This also closed a PRE-EXISTING hole (forged reminder-resolutions were
   never reconciled before 4b). The `resolved_via` field is provenance only, never a reconciliation seam.

2. **Couple-cost is reconciled at FIELD level (`active_seconds`), not just by presence.** Suppression-
   only detection is defeated by PARTIAL under-reporting (emit the session, shave the seconds). The gate
   field-diffs `active_seconds` with `skipWhenClaimAbsent:false`, keyed on the escalated `guest_id`
   carried as `about_guest_id` (a HARNESS-DERIVABLE join key, never a product-chosen opaque id).

3. **Stage B shares the ground-truth FACT, never the claim path.** Stage B now takes `(scenario, genome)`
   and re-derives the trusted resolved set + couple cost BY ITS OWN computation from `domain_facts.ts`
   (REMINDERS_NEEDED, spacingCapacity, couple-resolvability, escalation budget). It must NEVER import
   Stage A's emission/`guestOutcome` path — sharing the resolution computation would re-vacuum the gate
   (a bug corrupts both sides identically) and make the lying-genome keystone unconstructible. Reading
   the trusted, content-addressed genome does NOT break independence (Stage B still never reads
   `productEvents`). **`couple_resolvable` is a SCENARIO persona fact, never a genome field** — the genome
   supplies only the policy, so it can't assert a guest resolvable. See [[genome-content-address-firewall]].

4. **Escalation is INJECTED-only; never folded into the autonomous search.** The search box stays tier-1
   (cadence × spacing); a guard test pins that `search_proposer` never emits `autonomy_threshold`. So the
   convergence-certificate "no PROMOTABLE point" redefinition ([[search-convergence-certificate-semantics]]
   §4) **stays deferred** — no parked point arises mid-sweep. Honoring [[second-genome-knob-must-stay-tier1]].

5. **The gate VETOES, it does not correct.** The forge path is: forge → integrity fails → accept-rule
   condition 2 (no NEW gate failure vs baseline) rejects. The keystone asserts `new_gate_failures` is
   non-empty (not merely a fail), per forge face: forged couple-resolution, reminder-labeled forge, shaved
   `active_seconds`, suppressed session — each moves the claimed metric favourably yet is rejected.

**Deferred (recorded, not faked):** decision-event reconciliation (escalation emits none by design); the
convergence redefinition until tier-2 enters the search; prod key-custody for the trusted feed (offline
single-authorship recorder stands in, [[prod-trusted-evidence-channel]]). **`guest_sentiment_score` was
a claimed-only metric here (D7) — Phase 6 CLOSED that gap**: it is now trusted-backed (5th integrity
effect kind), see [[sentiment-trusted-reconciliation]]. `qa_accuracy_rate` stays claimed-only (no model).
