# Phase 6 — Trusted sentiment reconciliation (close the D7 claimed-only forge gap)

## Why this, why now

Phase 4b made the integrity firewall **load-bearing** over the two North-Star inputs escalation
touches — `rsvp_resolution_rate` (numerator) and `couple_active_minutes_total → effort_cost`
(denominator). It explicitly **deferred** `guest_sentiment_score`: "escalation doesn't touch it;
reconciling model-output metrics is out of scope" ([[escalation-forge-detection-load-bearing]] D7).

Phase 5 **changed that premise.** `reminder_batching`'s entire *upside* is the comfort-consolidation
term `feltTouches = ceil(received/digestSize)` → fewer felt nags → gentler `guest_sentiment_score`.
That term is **claimed-only** — `domain_facts.ts:96-98`: *"Comfort is a CLAIMED-ONLY signal (no
trusted backing), so only Stage A reads this."* So batching now **enlarges an unreconciled value the
search optimizes**: a lying planner (or a genome) can claim an arbitrary sentiment gain and nothing
catches it. `guest_sentiment_score = mean over EMITTED `guest.sentiment.sampled` samples`
(`metric_definitions.ts:123`), so **three** forges all pay today: inflate a score, **suppress** a
nagged guest's sample (raises the mean), or forge a phantom-happy guest.

`guest_sentiment_score` is half of the `guest_experience` North-Star component (the other half,
`boundary_hold_rate`, is already gate-covered via comms gates). Giving sentiment a trusted backing is
the **natural forge-detection follow-on** the Phase-5 handoff flagged — fully offline, load-bearing,
and a clean mirror of the Phase-4b pattern (a 5th reconciled effect kind: `guest_sentiment`).

**Why not the other candidate (`quality`).** Wiring the `quality` component (weight 0.4, always
`null`) needs either a real Claude judge → **API credentials → STOP rail** (offline-first), or a
fabricated deterministic stub → brushes the "do not simulate/fabricate results" rail **and** would
introduce a *new* unbacked claimed-only forge surface (the opposite of the safety theme). Deferred
until an offline-legitimate rubric design exists; recorded, not faked. `qa_accuracy_rate` likewise
stays an acknowledged deferral (no Q&A simulator model backs it).

## The design (the firewall pattern, applied to sentiment)

The honest sentiment score is a **deterministic function of ground-truth facts** both stages already
compute independently: `needed` (persona latency), `delivered = min(cadence, capacity(spacing))`, and
`resolved` (`effectiveNudges(delivered,batching) >= needed`). So Stage B **can** re-derive the honest
sentiment by its own computation and record it as trusted — and the gate field-diffs the claimed
`sentiment_score` against it. This honors the firewall discipline ([[loop-trusted-evidence-boundary]],
[[escalation-forge-detection-load-bearing]] #3): **share the FACT, never the claim path.**

- **Extract the sentiment FACT** into `domain_facts.ts` as a pure operator
  `honestSentimentScore(needed, delivered, resolved, spacing, batching)` (encapsulating
  `comfortCeiling`, `feltTouches`, `penaltyPerNag`, the formula). Both stages call it on the
  primitives **each computes independently** — Stage A emits the claim, Stage B records the trusted
  observation. A bug in one stage cannot corrupt both (neither imports the other's path).
- **Exact equality is provably safe here** (stronger than the `active_seconds` dyadic-constant
  precedent): because both stages call the *same pure function on the same inputs*, the results are
  **bit-identical** by construction — so `!==` never false-positives on an honest run, regardless of
  whether the constants are dyadic. The load-bearing invariant is therefore "both stages compute
  `(needed, delivered, resolved)` by the same shared facts," which they already do.
- **Completeness-invariant note (doddy):** sentiment is a *grader* input (North-Star numerator), not a
  *veto-gate* input — so this does not change the integrity-gate completeness invariant
  ([[integrity-gate-completeness-invariants]], "diff every field a VETO GATE reads"). It *extends* the
  firewall from gate-inputs to a grader-input, exactly as Phase 4b did for resolution/cost. Document
  this so a future reader doesn't conclude sentiment must become a gate input.

**Honest runs are unaffected** (claimed === trusted for every honest genome), so the search landscape,
the 3-D cube oracle, and the North-Star values are all **unchanged** — this is purely firewall
hardening, like 4b.

## Conventions (match the repo)

Green per step (`npm run build` standalone — check `$?`, never pipe to tail/grep — then `npm test &&
npm run lint`); commit per verified step; branch `build/phase-3-generalize-search` (the open review
artifact). Route adversarial review through `general-purpose` agents carrying the doddy (trust
boundary) and wolf (float/aggregation) lenses (named subagents are not provisioned here).

## Steps

- [ ] **Step 1 — Extract the sentiment model into a SHARED FACT (behavior-identical refactor).**
  Move `COMFORT_CAP`, `SENTIMENT_PENALTY_PER_NAG`, `SPACING_RELIEF`, `penaltyPerNag`, a new
  `comfortCeiling(needed)`, and `honestSentimentScore(needed, delivered, resolved, spacing, batching)`
  into `domain_facts.ts` (alongside `effectiveNudges`/`feltTouches`, with a docblock that this is now
  a SHARED fact both stages apply). Refactor `stage_a_planner.ts:guestOutcome` to call it (delete the
  local copies). **Verify behavior-identical:** the 3-D `metamorphic_oracle.test.ts` cube + the b=0
  pinned slice + every anchored sentiment value must pass **unchanged**. No new test in this step
  beyond confirming the suite stays byte-green.

- [ ] **Step 2 — Trusted sentiment observation type + recorder method.**
  `trusted_outcomes.ts`: `TrustedSentimentObservationRecord { guest_id; sentiment_score }` +
  `RecordSentimentObservationInput`, with a docblock explaining it backs the `guest_sentiment_score`
  metric the scorer computes over the CLAIMED stream. `trusted_recorder.ts`:
  `recordSentimentObservation` / `sentimentObservation(guestId)` / `allSentimentObservations()` —
  append-only (DUPLICATE_EFFECT on repeat guest), sealed-guard, deep-frozen — mirroring
  `recordCoupleSession`. Tests: append-only + sealed + retrieval (extend the recorder hardening tests).

- [ ] **Step 3 — Stage B authors a trusted sentiment observation for EVERY guest.**
  Extend `observeTrustedRecord`: for each guest compute `(needed, delivered, resolved)` by Stage B's
  OWN logic (it already computes these in `reminderResolves` — factor a small local helper, do NOT
  import Stage A) and `recordSentimentObservation({ guest_id, sentiment_score: honestSentimentScore(...) })`.
  One per guest (resolved, pending, and never-responder alike), matching Stage A's unconditional
  per-guest `guest.sentiment.sampled` emission. Test (`stage_b_observer.test.ts`): the **agreement
  sweep** — Stage B's trusted sentiment equals the honest Stage A claim for every guest across the
  64-point cube × representative latencies (immediate / after_one / after_multiple / never), so honest
  runs are gate-clean.

- [ ] **Step 4 — Integrity gate: the 5th reconciled effect kind `guest_sentiment`.**
  `report_event_names.ts`: `SENTIMENT_REPORT_EVENT_NAMES = { guest.sentiment.sampled }` with the
  reader-seam docblock. `integrity_gate.ts`: add `'guest_sentiment'` to the `effect_kind` union and a
  `detectSentimentDivergences` keyed on `guest_id` — **forged** (claimed sample, no trusted obs →
  phantom-happy guest), **field_mismatch** (`sentiment_score`, `skipWhenClaimAbsent: false` — an
  absent/non-numeric claimed score against a trusted value is a mismatch, not a skip), **suppressed**
  (trusted obs, no claim → dropped-unhappy-guest). Wire into `detectSelfReportDivergence`. Unit tests
  (`integrity_*` / `veto_gates`): each of the three forges yields a divergence of the right kind; an
  honest stream is clean.

- [ ] **Step 5 — Audit & fix existing fixtures that emit sentiment against a sentiment-free recorder.**
  The new forged-check fires when a `guest.sentiment.sampled` claim has no trusted observation. Tests
  using `observeTrustedRecord` get the trusted side for free (Step 3); audit the **hand-built**-recorder
  tests (`integrity_rsvp_couple`, `integrity_hardening`, `integrity_boundary`, `veto_gates`,
  `planner_simulator`, `offline_pipeline`, `rsvp_corpus` fixture) and add the matching trusted
  observation wherever an honest sentiment sample is emitted. Whole suite green.

- [ ] **Step 6 — THE keystone: a sentiment forge does not pay (tier-1, integrity is the sole stopper).**
  New `loop-orchestrator/tests/loop/sentiment_forge_keystone.test.ts` (mirrors the dilution-forge
  keystone). A tier-1 candidate whose HONEST `guest_sentiment_score` does not beat the champion; a
  lying Stage A that **inflates** sampled sentiment (arm A) and one that **suppresses** the nagged
  guest's sample (arm B) each move `guest_sentiment_score` above the champion (RED) yet the integrity
  gate produces a NEW gate failure and the candidate is **not accepted** (GREEN). No promotion-gate
  park — the candidate is tier-1, so INTEGRITY is the only stopper. Companion arm: the honest
  sentiment candidate is gate-clean (the veto targets the lie, not the model).

- [ ] **Step 7 — ADR 0006 + memory + handoff.**
  `docs/adr/0006-sentiment-trusted-reconciliation.md` (decision, the grader-input-vs-gate-input
  distinction, the shared-fact bit-identity argument, quality/qa_accuracy deferrals). New memory
  `[[sentiment-trusted-reconciliation]]`; update [[escalation-forge-detection-load-bearing]] (D7 now
  CLOSED for sentiment), [[third-tier1-knob-batching-3d-search]] (the batching comfort upside is now
  trusted-backed), and `MEMORY.md`. Update `.claude/handoff.local.md`.

## Adversarial review gates (apply findings before ticking)

- **doddy (trust boundary)** after Step 4: is the reconciliation genuinely independent (Stage B never
  reads Stage A), is the forged/suppressed/mismatch triple complete for a *per-guest-always-sampled*
  effect, and does `skipWhenClaimAbsent:false` correctly make a dropped/blank score a veto?
- **wolf (stats/float)** after Step 3: confirm the bit-identity argument (no honest-run false-positive
  across the full cube × latencies), and that suppression actually moves the mean (so the keystone's
  RED is real, not vacuous).
- **testineer** after Step 6: is the keystone's RED load-bearing (the forge truly out-competes the
  champion absent the gate), and are the oracle relations live, not pinned snapshots?

## Out of scope (recorded, not faked)
- `quality` North-Star component (needs a real judge → STOP, or a fabricated stub → rail breach).
- `qa_accuracy_rate` reconciliation (no Q&A simulator model backs it).
- Prod key-custody for the trusted feed (offline single-authorship recorder stands in,
  [[prod-trusted-evidence-channel]]).
