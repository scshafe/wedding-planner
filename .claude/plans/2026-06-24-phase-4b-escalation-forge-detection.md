# Phase 4b — Make INTEGRITY forge-detection load-bearing (escalate-to-couple + trusted RSVP-outcome reconciliation)

**Status:** IN PROGRESS. **Branch:** `build/phase-3-generalize-search` (the open review artifact for
`main`; 4a/4b build on it). **Predecessor:** Phase 4a — the tier-2 promotion gate (complete, 210 tests).

## Why this phase
4a made the firewall's tier-2 **human-gate** load-bearing (the loop parks accepted tier-2 candidates).
4b makes the firewall's **integrity forge-detection** load-bearing by introducing a REAL forge surface
in the *running offline model*: the `autonomy_threshold` (tier-2) knob drives an **escalate-to-couple**
behavior. Escalation resolves a still-pending guest by consuming the couple's attention — it raises the
`rsvp_resolution_rate` **numerator** AND the `couple_active_minutes_total → effort_cost` **denominator**,
a real non-separable value/cost tradeoff. This is the sanctioned escalation phase named in
`second-genome-knob-must-stay-tier1.md` and the handoff.

**The headline P0 (security):** the scorer computes metrics over the **CLAIMED** event stream
(`offline_scorer.ts:111` feeds `productEvents` to the metric engine), while the integrity gate today
only reconciles `commitment`/`integration` effects — and there are NONE of those in the RSVP model, so
the integrity gate is effectively **vacuous in the live offline loop**. RSVP resolution and couple cost
are **not in the trusted record at all**. So a lying planner could forge a `guest.rsvp.received` (inflate
the resolution numerator) and/or under-report `couple.session.ended` `active_seconds` (deflate the
denominator) and **lie its way to a higher North Star** with nothing to stop it. 4b closes this.

## Design reviews (two adversarial reviewers; the repo's named specialists are not provisioned here, so
`general-purpose` reviewers were framed as the security/trust-boundary reviewer (**doddy**) and the
architecture reviewer (**rigorous-architect**), as in 4a). Findings folded in as **[sec-…]/[arch-…]**.
Architect verdict: **SOUND-WITH-CHANGES**. The changes are D2–D7 below.

## Design decisions (locked)

**D1 — Escalation is exercised by INJECTED tier-2 candidates ONLY; it is NEVER folded into the
autonomous search box.** [arch-Q1, sec-P2-1] Per `second-genome-knob-must-stay-tier1.md`. The autonomous
search box stays the tier-1 2-D box (cadence × spacing); `search_proposer.genomeFor` hardcodes
`{rsvp_reminder_cadence, reminder_spacing}` and never emits `autonomy_threshold` (verified). A
**structural guard test** pins this: every genome the proposer enumerates derives tier-1 / carries no
`autonomy_threshold`, so the tier-1 search can never accidentally exercise the tier-2 behavior. The
convergence-certificate redefinition deferred in `search-convergence-certificate-semantics.md` §4
("converged = no PROMOTABLE point", an `awaiting_oversight` terminal) **stays deferred** — because the
proposer never emits tier-2, no parked-but-acceptable point can arise mid-sweep, so `isConverged()` stays
honest. 4b updates memory §4 to record this choice explicitly.

**D2 — Escalation emits only `couple.session.ended` (cost) + `guest.rsvp.received` (resolution); NO
decision events.** [sec-P0-4] This confines the new forge surface to exactly the two North-Star-hot
metrics — `rsvp_resolution_rate` (numerator) and `couple_active_minutes_total → effort_cost`
(denominator) — each fully reconciled below. Escalation deliberately emits NO `ai.decision.autonomous`
/ `couple.decision.*` events, so `autonomy_rate` and `decision_reversal_rate` (also claimed-event
metrics, a `higher_better` and the `stress_cost` guard) gain **no** new uncovered forge surface. Modeling
escalation as decision events + reconciling those four counts is a documented deferral. The couple-cost
is modeled purely as couple attention spent (`couple.session.ended.active_seconds`).

**D3 — Reconcile RSVP RESOLUTION AS ONE CONCEPT keyed on `guest_id`, regardless of cause (reminder OR
couple).** [sec-P0-1, arch-C1] A forged `guest.rsvp.received` for a never-responder labeled "reminder-
resolved" inflates the identical numerator and is invisible to an escalation-only reconciler — that is a
**pre-existing hole** this phase must close, not just the escalation door. Stage B authors a trusted
per-guest RSVP-outcome record (`resolved`, `rsvp_status`) for exactly the guests this genome's policy
resolves (reminder-resolved ∪ couple-resolved). The integrity gate reconciles EVERY claimed
`guest.rsvp.received` against that trusted set: `forged_effect` (claimed resolution the trusted record
did not observe — incl. an unknown `guest_id`), `field_mismatch` (`rsvp_status`), `suppressed_effect`
(trusted resolution with no claim). Resolution is one trusted numerator; the cause-label must not
partition it into a covered and an uncovered half.

**D4 — Reconcile couple-cost at FIELD level (`active_seconds`), keyed on the escalated `guest_id`,
three-way.** [sec-P0-2, sec-P0-3, sec-P1-1] Suppression-only detection is defeated by *partial* under-
reporting (emit every session but shave `active_seconds`). Each escalation = one couple session about
one guest → keyed by the escalated `guest_id` (harness-derivable, never a product-chosen opaque id).
Stage B authors the trusted `active_seconds` per escalated guest. The gate diffs `active_seconds`
**NOT** `skipWhenClaimAbsent` (a present session with absent/zero `active_seconds` against a positive
trusted cost is a `field_mismatch`, not a skip), plus the three-way cardinality (forged / suppressed /
mismatch) mirroring the commitment reconciler.

**D5 — Stage B takes `(scenario, genome)` but shares only the GROUND-TRUTH FACT, never the claim path.**
[arch-C2, sec-P1-3, sec-P1-4] A shared, genome-free helper `coupleResolvableGuests(scenario)` (alongside
the existing `REMINDERS_NEEDED` domain constant) encodes the domain *fact*. Stage A applies the genome
policy and emits CLAIMS; Stage B independently applies the same policy to the same fact and AUTHORS the
trusted record — **by its own computation, never by importing Stage A's `guestOutcome`/emission path**
(so a future bug can't corrupt both sides identically and re-vacuum the gate). Reading the genome in
Stage B does NOT break independence: the genome is the trusted, content-addressed, schema-validated
artifact (validated at the simulator boundary, `planner_simulator.ts:73-80`), and Stage B still never
reads `productEvents`. The keystone's lying arm stays constructible because the injected lying `Planner`
emits forgeries directly, bypassing the honest computation. **`couple_resolvable` lives in the SCENARIO
persona ground truth, never in the genome** — the genome supplies only the escalation *policy*
(threshold), not the *fact* of resolvability (else a proposer could mint a genome asserting every guest
is resolvable and Stage B would corroborate the forge).

**D6 — The new trusted effect family is `couple_resolution` / `rsvp_outcome`, authored in
`trusted_outcomes.ts` — NOT the ops `escalation_record` schema.** [arch-C4] `escalation_record_schema.json`
is the agent-operations **Tier-3 human-reserved incident** contract, a different concept; conflating them
would corrupt two contracts. New report-event-name sets go in `report_event_names.ts` (the reader-seam
invariant from `integrity-gate-completeness-invariants.md` — never inline a new event-name set in the
gate). This is the FIRST non-commitment/non-integration trusted effect family, and the first integrity
coverage of a field the North Star numerator/denominator actually reads.

**D7 — The integrity gate VETOES, it does not correct; the keystone asserts `new_gate_failures` is
non-empty vs baseline.** [arch-C1] The firewall path is: forge → integrity gate fails → accept-rule
condition 2 (no NEW gate failure relative to baseline) rejects the candidate. With an honest baseline
champion this holds; the keystone asserts `new_gate_failures` is non-empty (not merely `verdict==='fail'`)
so a baseline that also failed integrity could not let a forge through.

## Steps (each: `npm run build && npm test && npm run lint` green before ticking + committing)

- [x] **Step 1 — the ground-truth fact + shared domain helper (no behavior; matrix byte-identical) (D5).**
  - `eval-harness/schemas/guest_persona_schema.json`: add an OPTIONAL `couple_resolvable` boolean to
    `rsvp_truth.properties` (keep `additionalProperties:false`; do NOT add to `required`). Pin the
    meaning: ground truth that the couple can personally resolve this guest when escalated (typically a
    `never`/slow responder who is a close relative the couple will just call). Regenerate the contract TS
    type (`couple_resolvable?: boolean`).
  - Add a shared, genome-free domain-fact helper `coupleResolvableGuests(scenario)` (+ factor the
    `REMINDERS_NEEDED` ground-truth constant into a shared domain-facts module, or a clearly-marked shared
    constant) — the FACT both stages may read. NOT a policy/claim function.
  - Tests: existing fixtures still validate unchanged; **the pinned 16-value North-Star matrix in
    `metamorphic_oracle.test.ts` is byte-identical** (a guest with no `couple_resolvable` behaves exactly
    as today — no escalation wired yet). No genome-hash re-baseline (genome schema untouched).

- [x] **Step 2 — trusted RSVP-outcome + couple-cost family; Stage B authors it (Stage A still no
    escalation) (D3, D4, D5, D6).**
  - `trusted_outcomes.ts`: add `TrustedRsvpOutcomeRecord { guest_id, resolved, rsvp_status }` and
    `TrustedCoupleSessionRecord { guest_id, active_seconds }` (couple cost), with their record-input
    types. Author-only fields; mirror the existing trusted-type doc conventions.
  - `TrustedRecorder`: add `recordRsvpOutcome` / `recordCoupleSession` (append-only, deep-frozen,
    seal-guarded, DUPLICATE_EFFECT on repeat) + `rsvpOutcome(guestId)` / `allRsvpOutcomes()` /
    `coupleSession(guestId)` / `allCoupleSessions()` accessors.
  - `stage_b_observer.ts`: `observeTrustedRecord(scenario, genome)` — independently derive, from
    `coupleResolvableGuests(scenario)` + `REMINDERS_NEEDED` + the genome policy (cadence/spacing reach and
    `autonomy_threshold` escalation), the trusted resolved set (reminder-resolved ∪ couple-resolved) and
    the trusted couple cost per escalated guest. **By Stage B's own computation — do NOT import Stage A
    helpers.** Update `planner_simulator.ts` to pass the candidate/champion genome to Stage B.
  - Stage A unchanged (no escalation). The integrity gate is NOT yet reconciling these → honest runs
    unaffected. Tests: Stage B authors the right trusted resolutions/costs for fixtures; honest Stage A's
    reminder-resolution claims MATCH Stage B's trusted resolved set (the agreement the Step-3 gate needs).

- [x] **Step 3 — the integrity gate gains the RSVP-outcome + couple-cost effect-kinds; firewall lands
    BEFORE the escalation behavior (D3, D4, D6, D7).**
  - `report_event_names.ts`: add `RSVP_RECEIVED_REPORT_EVENT_NAMES = { guest_rsvp_received }` and
    `COUPLE_SESSION_REPORT_EVENT_NAMES = { couple_session_ended }` (the reader-seam single definitions).
  - `integrity_gate.ts`: add `detectRsvpOutcomeDivergences` (reconcile EVERY claimed `guest.rsvp.received`
    by `guest_id` against the trusted resolved set — forged / `rsvp_status` mismatch / suppressed) and
    `detectCoupleSessionDivergences` (reconcile `active_seconds` by escalated `guest_id`,
    `skipWhenClaimAbsent:false` on `active_seconds`, three-way). Extend `detectSelfReportDivergence` and
    the completeness invariant to the new fields. Add `effect_kind` members `'rsvp_resolution'` /
    `'couple_session'`.
  - A **completeness-invariant test** asserts: every metric input derived from a claimed event a trusted
    record can corroborate (rsvp_status → resolution_rate; active_seconds → effort_cost) has a
    corresponding field in the integrity diff — so a future metric over these events can't silently reopen
    the hole. [sec-P1-2]
  - Prove the WHOLE existing honest corpus stays GREEN under the new gate (Stage B's trusted set matches
    honest Stage A's reminder-resolution claims for every scenario). This is the firewall landing with no
    forge surface yet enabled — the window-free order. [arch-C3]

- [x] **Step 4 — Stage A escalation behavior (the forge surface) — now fully guarded (D1, D2, D5).**
  - `stage_a_planner.ts`: read `genome.parameters.autonomy_threshold`; for guests still pending after
    reminders, escalate the `couple_resolvable` ones per the threshold policy (more at higher threshold).
    Each escalation emits `couple.session.ended` (with `active_seconds` = the true couple cost) and, for a
    resolved guest, `guest.rsvp.received` with `rsvp_status`. HONEST: resolve only ground-truth couple-
    resolvable guests, spend only the true cost. A genome WITHOUT `autonomy_threshold` drives ZERO
    escalation (the tier-1 path is byte-identical to today).
  - The **box-is-tier-1 / no-accidental-escalation guard test** [sec-P2-1, arch-C5]: an autonomously-
    proposed genome (no `autonomy_threshold`) emits no escalation events; the search proposer's enumerated
    box never carries `autonomy_threshold`.
  - Tests: an honest escalating tier-2 genome passes the integrity gate; resolution↑ and effort_cost↑ both
    move (the real tradeoff). Existing corpus + pinned matrix unaffected (no `couple_resolvable` ⇒ no
    escalation).

- [x] **Step 5 — THE KEYSTONE (integrity forge-detection is load-bearing) (D2, D3, D4, D7).**
  - **(a) the forge doesn't pay (RED/GREEN):** an INJECTED tier-2 lying planner forges a couple-resolution
    for a non-resolvable guest (and a sibling arm: forges a *reminder*-labeled resolution for a never-
    responder [sec-P0-1]; and a sibling: under-reports `active_seconds` [sec-P0-2]) → the integrity gate
    fires → the candidate's run has a **NEW gate failure vs the honest baseline** (`new_gate_failures`
    non-empty) → REJECTED by the accept rule. *RED with the new effect-kinds/field-diffs absent (the forge
    inflates the score unchecked); GREEN with them.* [sec-P2-2, arch-C1/D7]
  - **(b) honest escalation parks:** an INJECTED tier-2 genome that HONESTLY escalates beats a suboptimal
    champion on resolution, PASSES the integrity gate, but PARKS at the 4a promotion gate (tier-2, no
    approval) — champion unchanged, `awaiting_oversight`. (Reuses the 4a gate; confirms the two firewalls
    compose.)
  - **(c) suppression:** a planner that suppresses a trusted couple-resolution / couple-session is caught
    (`suppressed_effect`).

- [ ] **Step 6 — metamorphic relations (lean) + ADR + memory + handoff.**
  - `metamorphic_oracle.test.ts`: add anchored, non-circular escalation relations — raising
    `autonomy_threshold` (with ≥1 `couple_resolvable` pending guest) raises `rsvp_resolution_rate` AND
    raises `couple_active_minutes_total` (effort_cost); the net North-Star effect is genome/scenario-
    dependent (NOT a free win). Keep the matrix lean; the full value/cost matrix may defer to a later
    phase if this step strains (arch scope-cut) — but the honest-tradeoff relation is in-scope.
  - `docs/adr/0004-escalation-forge-detection.md`: D1–D7.
  - Memory: new `escalation-forge-detection-load-bearing` (the trusted RSVP-outcome family; resolution
    reconciled as one concept by guest_id; field-level active_seconds; Stage B shares the fact not the
    claim; escalation injected-only / box pinned tier-1; emits no decision events by design). Update
    `second-genome-knob-must-stay-tier1` (4b built the escalation forge-detection), `search-convergence-
    certificate-semantics` §4 (deferral choice recorded), `integrity-gate-completeness-invariants` (now
    covers the RSVP-outcome family). Index in `MEMORY.md`.
  - Update `.claude/handoff.local.md`.

## Invariants this phase must not break
- Offline-first; no real side effects; one safety model; `ops/` and `CLAUDE.md` untouched.
- The content-address firewall: validate-before-bind; derive tier from content; the integrity gate diffs
  the FULL trusted field-set any gate/metric reads (completeness invariant), via the shared reader-set.
- **The autonomous loop cannot self-grant tier-2 autonomy** (the 4a rail is untouched and unweakened);
  escalation is injected-only and the search box is pinned tier-1 (guard test).
- Stage A/B independence: Stage B never reads `productEvents`; it shares the ground-truth FACT, never the
  claim path. The integrity gate stays non-vacuous.
- No genome-hash re-baseline; the Phase-3 pinned 16-value North-Star matrix stays byte-identical.
- The Phase-3/4a convergence-certificate semantics are unchanged (the redefinition stays deferred until a
  phase actually puts tier-2 in the autonomous search).
