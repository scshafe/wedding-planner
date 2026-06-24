# Handoff

## Where things stand — Phase 4b (escalation forge-detection) is BUILT ✅
`.claude/plans/2026-06-24-phase-4b-escalation-forge-detection.md` is **complete — all 6 steps ticked**,
on branch **`build/phase-3-generalize-search`** (Phase 3 is the open review artifact for `main`; 4a + 4b
build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**234 tests**, up from 210 at the start of this run).
`main` contains Phase 1 + Phase 2; this branch is the review artifact for Phase 3 **and** 4a **and** 4b.

**What changed:** the firewall's integrity gate (`INTEGRITY.SELF_REPORT_DIVERGENCE`) went from
**effectively vacuous in the live loop** (it only reconciled commitment/integration effects, of which the
RSVP model emits none) to **load-bearing**. The headline 4a→4b P0 — the scorer computes every metric over
the CLAIMED event stream, so a forged couple-resolution / shaved couple-cost could inflate the North Star
unchecked — is closed. 4a made the human-gate load-bearing; 4b makes the forge-detection load-bearing.

### What's new this phase (by step)
- **Step 1** — optional `couple_resolvable` ground-truth fact on `guest_persona` `rsvp_truth` (scenario
  fact, never genome/product) + shared `domain_facts.ts` (the FACTS both simulator stages read). Matrix
  byte-identical, no genome-hash re-baseline.
- **Step 2** — trusted `TrustedRsvpOutcomeRecord` + `TrustedCoupleSessionRecord` families + recorder
  methods; **Stage B now takes `(scenario, genome)`** and independently authors the trusted resolved set
  (reminder ∪ couple-escalation) + couple cost — by its OWN computation, sharing only the FACTS, never
  Stage A's emission path. Stage A unchanged here; gate not yet reconciling, so honest runs unaffected.
- **Step 3** — the integrity gate gains `rsvp_resolution` + `couple_session` effect-kinds: reconciles
  EVERY claimed `guest.rsvp.received` by `guest_id` (any cause — closing a PRE-EXISTING reminder-forge
  hole) + `couple.session.ended` `active_seconds` (field-diff, `skipWhenClaimAbsent:false`). New shared
  reader-sets in `report_event_names.ts`; completeness-invariant test. The firewall lands BEFORE Step-4
  escalation (window-free order). Two loop fixtures had to author honest trusted outcomes — the firewall
  correctly biting.
- **Step 4** — Stage A escalate-to-couple behavior: `autonomy_threshold` escalates pending couple-
  resolvable guests, emitting `couple.session.ended` (cost, `about_guest_id` join key) + `guest.rsvp.received`.
  Box-is-tier-1 guard test: `search_proposer` NEVER emits `autonomy_threshold`.
- **Step 5** — THE KEYSTONE (`escalation_forge_keystone.test.ts`): 5 arms, each the RED/GREEN fact "the
  forge moves the claimed metric favourably but produces a NEW gate failure vs the honest baseline →
  rejected": forged couple-resolution, reminder-labeled forge, shaved `active_seconds`, suppressed session,
  and honest escalation that WINS on resolution yet PARKS at the tier-2 gate (firewalls compose).
- **Step 6** — metamorphic escalation relations (resolution↑ AND effort_cost↑, not a free win) +
  `docs/adr/0004` + memory ([[escalation-forge-detection-load-bearing]] + updates to three related files)
  + this handoff.

## Next action — your call. Recommended: Phase 5 = the FORGE-FREE third tier-1 knob (stress the search)
4a + 4b made BOTH tier-2 firewalls (human-gate, forge-detection) load-bearing. A clean, in-rails next
phase that builds on the now-hardened substrate WITHOUT new tier-2 surface:
- **A 3rd TIER-1, FORGE-FREE knob** (e.g. a channel/timing-of-day flow knob) to take the autonomous search
  to 3-D — stresses the spread-first enumeration, the convergence certificate, and the non-separability
  story at higher dimension. Per [[second-genome-knob-must-stay-tier1]] it MUST be tier-1
  (`planning_flow_orchestration`) AND forge-free (manufactures no trusted outcome → Stage B unchanged), or
  it breaks autonomous operation. This is `wolf`/`testineer` territory (landscape + metamorphic matrix).

Alternatives (also in-rails):
- **The deferred convergence redefinition** ([[search-convergence-certificate-semantics]] §4) — only worth
  doing as the prelude to a phase that genuinely puts tier-2 in the autonomous search, which memory says
  not to do; so this is low priority unless that policy changes.
- **Decision-event reconciliation** (4b deferred, D2): if a future escalation model emits
  `couple.decision.*` / `ai.decision.autonomous`, reconcile the counts that feed `autonomy_rate` /
  `decision_reversal_rate` before emitting them.
- **The real Claude-Agent-SDK proposer** (needs API credentials → STOP-and-surface, the local-only rail).

## Non-obvious Phase-4b context (carry forward)
- **The integrity gate is now load-bearing in the LIVE loop, not just unit tests.** Before 4b it fired
  only on synthetic commitment/integration events; now it reconciles the RSVP resolution numerator + couple
  cost denominator that the North Star actually reads.
- **Resolution is ONE concept keyed on `guest_id`, regardless of cause.** Do not re-split it by
  `resolved_via` — that reopens the reminder-labeled forge. `resolved_via` is provenance only.
- **`active_seconds` is field-diffed with `skipWhenClaimAbsent:false`** — partial under-reporting (not just
  suppression) is the real cost forge; an absent/zero value vs positive trusted is a mismatch.
- **Stage B shares the FACT (`domain_facts.ts`), never the claim path.** It must NEVER import Stage A's
  `guestOutcome`/emission — that would re-vacuum the gate. `couple_resolvable` stays a SCENARIO fact.
- **Escalation is INJECTED-only; the search box is pinned tier-1 (guard test).** The convergence
  certificate is unchanged; its redefinition stays deferred. The 4a human-gate rail is untouched.
- **`guest_sentiment_score` is still a claimed-only metric** (no trusted backing) — escalation doesn't
  touch it; reconciling model-output metrics is out of scope (like `qa_accuracy_rate`).
- **`npm run build` is still `tsc --noEmit`** (strict typecheck, no emit). No deployable runtime yet.
- Durable facts: `MEMORY.md` index — 4b added **[[escalation-forge-detection-load-bearing]]** and updated
  [[second-genome-knob-must-stay-tier1]], [[search-convergence-certificate-semantics]] §4,
  [[integrity-gate-completeness-invariants]]. Still load-bearing: [[tier2-promotion-gate-is-load-bearing]],
  [[genome-content-address-firewall]], [[loop-trusted-evidence-boundary]], [[accept-rule-composition-invariance]].
