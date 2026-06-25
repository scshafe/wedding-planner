# Handoff

## Where things stand — Phase 6 (trusted sentiment reconciliation) is BUILT ✅
`.claude/plans/2026-06-24-phase-6-sentiment-trusted-reconciliation.md` is **complete — all 7 steps ticked**,
on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3/4a/4b/5/6
build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**263 tests**, up from 249 at the start of this run).
`main` contains Phase 1 + Phase 2; this branch is the review artifact for Phases 3, 4a, 4b, 5 **and 6**.

**What changed:** `guest_sentiment_score` (half of the `guest_experience` North-Star component) went from
**claimed-only** to **trusted-backed**. The integrity firewall gained a **5th reconciled effect kind
(`guest_sentiment`)**: Stage B now authors one trusted sentiment observation per guest (via the new SHARED
`honestSentimentScore` fact), and the gate reconciles every claimed `guest.sentiment.sampled` against it.
This CLOSES deferral **D7** of ADR 0005 — Phase 5's batching comfort-upside flows entirely through this
metric, so Phase 5 had *enlarged* an unreconciled forge surface; Phase 6 closes it. Honest runs are
unchanged (claimed === trusted, bit-identical) — purely firewall hardening, like 4b. See `docs/adr/0006`.

### What's new this phase (by step)
- **Step 1** — extracted the sentiment formula into `domain_facts.ts` as the SHARED pure fact
  `honestSentimentScore(needed, delivered, resolved, spacing, batching)` (with `comfortCeiling`,
  `penaltyPerNag`). Stage A refactored to call it — behavior-identical (the 3-D cube oracle + b=0 slice
  pass unchanged).
- **Step 2** — `TrustedSentimentObservationRecord {guest_id, sentiment_score}` + `recordSentiment
  Observation`/`sentimentObservation`/`allSentimentObservations` on the recorder (append-only, sealed,
  deep-frozen — mirrors couple sessions).
- **Step 3** — Stage B (`observeTrustedRecord`) authors one trusted sentiment observation per guest via
  its OWN `guestReach` primitives (never imports Stage A). Agreement sweep pins trusted == claimed EXACTLY
  across the 64-cube × 4 latencies (bit-identical by shared computation).
- **Step 4** — integrity gate's 5th effect kind `guest_sentiment`: forged (phantom guest) / field_mismatch
  (inflated or absent score, `skipWhenClaimAbsent:false`) / suppressed (dropped unhappy guest).
- **Step 5** — audit: the full honest suite stayed green (every honest-stream integrity test routes
  through `observeTrustedRecord`, now sentiment-backed; no hand-built recorder test emits sentiment).
- **Step 6** — THE keystone (`loop-orchestrator/.../sentiment_forge_keystone.test.ts`): a tier-1 candidate
  whose honest sentiment LOSES to the champion; 3 forge arms (inflate, suppress, duplicate) each move the
  claimed metric favourably but the integrity gate vetoes and it's rejected (sole stopper — tier-1).
  Companion: honest candidate gate-clean.
- **Adversarial review (doddy + wolf, general-purpose proxies)** — both INDEPENDENTLY found the same hole:
  the mean-over-samples metric had no cardinality guard, so a DUPLICATE happy sample re-weights the mean
  past the field/forge/suppress checks. **Fixed:** the gate now vetoes a 2nd sample for an already-reported
  guest as a `forged_effect` (+ unit test + a 4th keystone arm). doddy/wolf otherwise approved (independence
  sound, exact-equality safe by bit-identity, RED load-bearing).
- **Step 7** — `docs/adr/0006` + memory ([[sentiment-trusted-reconciliation]] + updates to
  [[escalation-forge-detection-load-bearing]] D7 and [[third-tier1-knob-batching-3d-search]]) + this handoff.

## Next action — your call. Recommended: a real claimed-metric still-open, OR the deferred convergence work
The 3-D autonomous search, both tier-2 firewalls, and now the sentiment forge-detection are all
load-bearing. In-rails options (ranked):
- **`qa_accuracy_rate` trusted backing** — the LAST claimed-only metric in `completeness` (alongside the
  now-closed sentiment). It has NO simulator model today (there's no Q&A model), so this needs a small Q&A
  outcome model in Stage A/B first (a guest-question → AI-answer correctness fact), then the same
  reconciliation pattern. Natural continuation of the forge-detection arc; fully offline. `wolf`/`doddy`.
- **The `quality` North-Star component** (weight 0.4, still `null`) — the biggest unbuilt VALUE lever, but
  it needs a real Claude judge → **API credentials → STOP-and-surface** (offline-first rail), OR a
  deterministic stub rubric (brushes "don't fabricate" + adds a NEW unbacked claimed-only forge surface).
  Do NOT build the stub silently; if you take this, design an offline-legitimate rubric first or STOP.
- **A 4th tier-1 knob → 4-D** (e.g. a timing-of-day knob) — more search-generalization; lower marginal
  value than closing the last claimed-metric gap. Needs per-guest receptivity ground truth (ADR 0005 alts).
- **The deferred §4 convergence redefinition** — only worth it as a prelude to putting tier-2 in the search,
  which memory says not to do; low priority.

## Non-obvious Phase-6 context (carry forward)
- **Exact sentiment equality is safe by BIT-IDENTITY, not dyadic constants.** Both stages call the same
  pure `honestSentimentScore` on the same primitives → identical bits. The real invariant: sentiment's
  inputs must come only from `domain_facts` shared facts AND be computed at an identical pipeline point in
  both stages. Today both use the **reminder-only** `resolved` BEFORE escalation (a couple-resolved guest
  has `resolved=false` for sentiment on both sides). If a future phase makes sentiment depend on
  couple-resolution / `autonomy_threshold` / anything one stage computes differently, the exact diff will
  false-positive EVERY honest run. The Step-3 agreement sweep guards the *current* inputs only.
- **The integrity gate keys per-effect by an id-SET; any per-event aggregator (mean/sum) needs duplicates
  handled.** `guest_sentiment_score` means over every sample → a duplicate re-weights it; fixed by
  vetoing repeated guest_ids. `rsvp_resolution_rate` dodges this via `distinct`. **The next per-event
  mean/sum metric added MUST either dedup by its id or have duplicates vetoed** ([[sentiment-trusted-reconciliation]] #2).
- **Sentiment is a GRADER input, not a VETO-GATE input** — it does NOT change the integrity-gate
  completeness invariant (that's about fields veto gates read). Don't conclude sentiment must be a gate input.
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&` — the
  pipe masks the build's non-zero exit. Run build standalone and check `$?`.
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens, as this run did.
- Durable facts: `MEMORY.md` index — Phase 6 added **[[sentiment-trusted-reconciliation]]** and updated
  [[escalation-forge-detection-load-bearing]] (D7 closed) + [[third-tier1-knob-batching-3d-search]]. Still
  load-bearing: [[tier2-promotion-gate-is-load-bearing]], [[genome-content-address-firewall]],
  [[loop-trusted-evidence-boundary]], [[integrity-gate-completeness-invariants]],
  [[accept-rule-composition-invariance]], [[second-genome-knob-must-stay-tier1]],
  [[search-convergence-certificate-semantics]].
