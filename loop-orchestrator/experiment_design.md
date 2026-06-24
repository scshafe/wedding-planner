# Experiment Design

How an offline survivor is validated in production before promotion. Offline scoring proves a
change is good *against the corpus*; this stage proves the corpus was right *about reality*. It is
where the loop spends its scarce, consequential resource — real couples' weddings — so it is
deliberately slow, gated, and statistically honest.

A standing input this whole design depends on: the **couple arrival rate** (onboardings per week,
by region and season). It is the denominator of every power and duration claim below; record it as
a design input (`stats.expected_arrival_rate`) — without it, none of the sample-size or
detectability claims can be evaluated, and wedding volume is low relative to web-scale, so this is
the binding constraint, not an afterthought.

## The funnel (each stage is a strictly higher level of exposure)

1. **Shadow.** The candidate runs in parallel on real traffic but **takes no real-world action**.
   - **Inertness is enforced at network egress, not at the commit boundary.** "Don't execute the
     booking" is not enough: computing a would-be decision ("which vendor it'd book") can require
     availability/quote/hold calls that are themselves stateful or billable. All shadow third-party
     I/O routes through a **recording sandbox proxy physically unable to reach production vendor
     endpoints**; every third-party call the candidate can make is classified read-only-idempotent
     vs. stateful, and stateful calls are blocked in shadow.
   - **Shadow carries canary-grade guardrails** (vendor-hold count, outbound-message count,
     per-call billing) — it is *not* the unmonitored stage.
   - **Divergence is a defined statistic, not a vibe.** Shadow logs would-be decisions as the same
     telemetry events with a `shadow` flag (so metrics stay single-sourced). "Diverges sharply" =
     the decision-disagreement rate vs. control (or the equivalence test between offline-predicted
     and shadow-observed primary) crosses a pre-registered bound with an always-valid CI. A
     diverging candidate is sent back and the divergent situation becomes an adversarial scenario.
2. **Canary.** A small, **sticky** cohort gets the real candidate under full guardrail monitoring.
   Small enough that harm is bounded; real enough to measure.
3. **Ramp.** Exposure increases in bounded steps (`ramp_step_index` on the rollout stage), each
   step re-clearing the decision rule.
4. **Full.** Promoted to 100%; the candidate becomes the new control.

> Note: Tier-0 candidates skip shadow (`offline → canary`); this intentionally forgoes divergence
> detection on the highest-volume tier — acceptable only because Tier 0 touches no booking/money/comms.

## Assignment: sticky, at onboarding — and clustered when inventory is shared

A wedding lifecycle is 12–18 months. Assignment is at **couple onboarding** and **sticky for the
engagement** — a couple never flips between control and candidate mid-planning. Ramping means
onboarding *new* cohorts under the candidate, not reassigning existing couples.

**Per-couple randomization is unsafe for any candidate that touches booking.** Venues, caterers,
and bands are shared, finite inventory, so a candidate arm that books more aggressively **depletes
the supply the control arm draws from** — the SUTVA assumption (a couple's outcome depends only on
its own arm) breaks, and the measured contrast *overstates* the effect (it partly transfers value
from control, and evaporates at 100% when there is no control to cannibalize). That is a false
promote. Therefore:

- Any candidate touching `venue`/`catering`/`music`/`budget_management` randomizes by
  **`region_date_cluster`** (region × wedding-date-window) with the **cluster as the analysis
  unit** (or a mixed model with a region×month random effect), so within-cluster supply
  competition is shared by both arms and cancels in the contrast.
- Where cluster volume is too thin (the low-volume reality), run a **saturation design** — vary
  the *fraction* of a cluster exposed — to estimate the spillover slope, and add a guardrail on the
  **control arm's** booking-success metrics: a control degradation coincident with candidate ramp
  is an interference flag, not a candidate win.
- Non-booking candidates (copy, comms tone, orchestration) may use per-couple assignment.

Every production candidate must be `mid_engagement_safe`, and that property is **verified, not
asserted**: a rollback-simulation gate proves that, for in-flight couple state under the candidate,
the control behavior accepts that state with no orphaned artifacts (no dangling holds, no un-owned
autonomy scopes). A self-set boolean does not gate a production-affecting property.

## Leading indicators decide; lagging outcomes validate — but surrogacy must be earned

The true outcome — a happy wedding, final budget adherence, day-of satisfaction, retention, NPS —
lands 12–18 months out. The loop cannot gate on it. So decisions ride leading indicators
(time-to-first-bookable-plan, `couple_active_minutes_total`, `rsvp_resolution_rate`,
`qa_accuracy_rate`, guardrail breaches, the eval-mirrored `north_star_ratio`). But a leading
indicator may stand in for the true outcome **only if it is a validated surrogate** — otherwise the
loop optimizes a proxy that diverges from what matters (the surrogate paradox: helps the leading
metric, harms the outcome). Driving `couple_active_minutes_total` *down*, for instance, can mean
"less drudgery" (good) or "couple disengaged and will churn" (bad) — the leading metric alone can't
tell them apart.

- **Validate surrogacy before trusting an indicator as a primary.** Run a **meta-analytic
  surrogate validation** over the ledger of past promotions that now have mature lagging data:
  estimate the **proportion of treatment effect explained** (Prentice criteria / Freedman PTE, or
  a causal-surrogacy estimator) on `lifecycle_retention_rate` / `paid_conversion_rate` /
  `referral_nps`. Only indicators clearing a pre-registered surrogacy threshold may be a primary;
  others are monitored-only.
- **The lagging guardrail is corrective, not merely advisory.** A leading-vs-lagging mismatch does
  not silently roll back a long-promoted change for in-flight couples — but it **freezes future
  cohort assignment to that candidate and opens a Tier-2 human review**. "Never retroactively
  reconsider" is the wrong default for an autonomous promoter.
- **Pair every downward-optimized effort metric with an early-retention/engagement guard** (the
  online analogue of the catalog's Goodhart guards), so a "less effort" win that is really
  disengagement is caught early.
- Use a **surrogate index** (predict the lagging outcome from the basket of leading indicators) to
  get variance/power on the slow endpoint — CUPED cannot help a metric with no pre-period.

## Statistical decision rules

- **Primary effect — always-valid, with its knobs pinned.** The engine peeks continuously, so it
  uses **always-valid inference** — **e-values / confidence sequences** preferred (they compose
  with online FDR below), or **mSPRT** with its **mixture variance `tau_squared` pinned to the
  MDE** (too wide → badly under-powered at low volume; too narrow → fragile type-I). A "sequential
  Bayesian" variant is only valid if it is a *proper* sequential test (Bayes-factor / e-process or
  a prior whose operating characteristics are simulated) — a peeked credible interval with a
  convenience prior inflates type-I. Record `method`, `tau_squared`/`prior_spec`, `alpha`, and
  `sidedness` (one-sided for promote) with every readout so it is reproducible. Promote is one-sided.
- **Power is a precondition, not a hope.** Require an **MDE and target power** in the rollout stage;
  derive `min_exposure_count` from them via a sequential expected-sample-size analysis — not the
  reverse. If the feasible MDE at the arrival rate exceeds plausible effect sizes, that is a
  finding: promote on a **variance-reduced or pooled / surrogate-index estimate**, never a
  pretend-powered per-experiment primary. `min_duration_days` is strictly positive (a window must
  cover a leading metric's event horizon; for time-to-event leading metrics use a survival
  estimator, not a rate at an arbitrary cutoff).
- **Multiple comparisons — online FDR, not Benjamini-Hochberg.** The loop launches experiments
  **continuously over time**; there is no fixed, simultaneously-tested family, so BH does not
  provide a valid guarantee. Use an **online FDR procedure — LORD++ / SAFFRON / ADDIS** (ADDIS when
  most candidates are null, the realistic case): alpha-investing lets the family grow forever
  without inflating the false-discovery rate, and it composes with e-values. BH is permitted *only*
  for a genuinely batched retrospective re-analysis, never the live promote gate.
- **Guardrails — out-of-band source, and the right test for the metric's type.** Safety-critical
  guardrails read **out-of-band signals the product cannot author** (payment-processor charge
  ledger, vendor confirmations, chargeback/complaint feeds), never the product's self-reported
  stream. Then:
  - **Hard-veto guardrails** (zero-event counters like `unauthorized_commit_count`): trip on the
    first occurrence — immediate, no sequential test, by design.
  - **Rate guardrails** (`qa_accuracy_rate`, `decision_reversal_rate`): monitor with a **one-sided
    sequential harm test** (confidence sequence / CUSUM) tuned to a pre-registered `harm_mde` and a
    stated `false_alarm_rate` — a fixed scalar threshold under continuous monitoring is itself an
    uncontrolled peeking detector that either false-alarms or detects harm late. Frame as
    **non-inferiority** against a harm margin δ ("clean" = the CI lies above −δ, not "no significant
    harm" — absence of a signal at low N is not safety).
  A breach triggers immediate auto-rollback (`decided_by: circuit_breaker`); winning the primary
  never excuses guardrail harm.
- **The contrast is always concurrent.** Compare candidate vs. control **within onboarding-window**
  (blocked by onboarding-week) — never a before/after or across-ramp-step pooled comparison, which
  confounds the effect with seasonality (wedding demand is highly seasonal) and novelty. Run a
  **novelty/primacy check**: early-tenure vs. mature-tenure within the candidate arm; a gain that
  decays with tenure is an artifact.
- **Heterogeneity — shrink, don't scan.** Estimate segment effects (low-budget, two-cultures,
  multilingual-guest-heavy) with a **hierarchical / partial-pooling model** that borrows strength
  across segments, and test each as **non-inferiority against a harm margin** with FDR control
  across the *fixed, finite* segment family (here BH *is* appropriate — the family is simultaneous).
  Record `segment_estimate` + `segment_ci` + `segment_powered` — never a bare boolean, so
  "we couldn't tell" is distinguishable from "no harm."
- **Variance reduction, honestly.** CUPED only helps in proportion to ρ² between covariate and
  metric — gate the power credit on a **measured `cuped_variance_reduction_achieved`** and fall
  back to stratification when ρ is low. For the bounded-ratio primary, regression-adjust on a
  **variance-stabilized scale**, not raw CUPED on [0,1].

### The primary estimand

`north_star_ratio` is a **zero-inflated, bounded ratio** (any veto-gate failure zeroes it). Do not
analyze it as a raw mean: **decompose** into the gate-failure rate and the among-passers quality
(a difference-in-means otherwise conflates "shifted quality" with "changed the failure rate"), and
report **quantile treatment effects / the CDF shift**, not just the mean — so a change that lifts
the median while crushing the lower tail (the couples it fails) is caught.

## Decision rule (per ramp step)

Advance/promote a stage iff **all** hold (an intersection-union test — all sub-tests must pass,
which controls false-promote at α; size each sub-test for power so real harm is caught):

- primary improves with always-valid significance, after the MDE-derived min exposure/duration;
- every guardrail **non-inferior** (CI above its harm margin), with hard-veto breakers clean;
- online-FDR-controlled across the live experiment stream;
- no segment harm (shrinkage estimate), on a concurrent within-window contrast;
- (for booking candidates) no control-arm interference flag.

Otherwise `hold` (keep gathering) or `rollback` (guardrail breach, or a clear losing readout).
Every outcome is written to the candidate's `rollout_result` and `ledger_entry`.

## Feeding the corpus

Two production signals refill the adversarial set and keep the loop from going permanently dry:
1. **Offline/online divergence** — graded well offline, behaved differently in shadow/canary.
2. **Production guardrail breaches and complaints** — real failures the corpus didn't anticipate.

Both are written as `new_adversarial_candidates` and admitted into
`../eval-harness/scenarios/adversarial/` **through the enforced admission gate** (must fail the
current product, must increase coverage, human Tier-3 review — see
`../eval-harness/scenarios/README.md`). The corpus is thus authored in part by production reality,
which is what stops offline scores from drifting away from truth.
