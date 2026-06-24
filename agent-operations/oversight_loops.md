# Oversight Loops

The *dynamics* of the roster: how work gets done and reviewed, on what cadence, by whom, and how
the whole team is kept honest without a human in the operating loop. `agent_roster.md` fixed the
**static authority** of each role; this file fixes how those roles actually run and watch each
other. It introduces no new safety model — it is `shared_operating_discipline.md` (and the loop's
`../loop-orchestrator/safety_and_governance.md`) applied to the question *"who checks the agents?"*

## The central move: oversight is the meta-gaming firewall, turned sideways

The product loop's hardest problem was that an optimizer able to influence its own fitness function
will game it instead of improving the product; it was solved by walling the proposer off from its
objective and deciding on **evidence the actor cannot author**
(`../loop-orchestrator/safety_and_governance.md` §1). The roster's hardest problem is the same one
rotated 90°: *"who watches the watcher, and the watcher's watcher, …?"* It is solved the same way —
by walling every agent off from **the judgment of its own work**, and deciding whether work lands
on **evidence the actor cannot author**.

This dissolves the regress. The chain of "who validates the validator" does **not** terminate at a
maximally-trusted agent (there is none). It terminates at **non-agent ground truth** — the harness
trusted recorder, the out-of-band production signals, the append-only hash-chained ledger, and the
deterministic gates — none of which any agent (or coalition of agents) can author or rewrite. That
floor needs no watcher because it is not an agent. Everything above it is anchored *downward* to it,
not *upward* to a more-trusted reviewer.

Three structural facts make the regress finite, and they are the spine of everything below:

1. **It bottoms out in non-agent evidence.** Every oversight check ultimately reads trusted,
   out-of-band evidence — never another agent's account of itself (`shared_operating_discipline.md`
   §2; `../telemetry/README.md` "Integrity"). *This is true by construction in the eval harness and
   must be **made** true in production* — see "Making the floor un-authorable in production."
2. **Oversight is additive-only.** A reviewer may *raise* scrutiny — flag, block, escalate, raise a
   tier — and may **never** *lower* it: no clear, approve-past, widen, or bypass. So a captured or
   colluding reviewer degrades to *"no review happened,"* which falls through to the deterministic
   floor + breakers + human cadence — **never** to *"bad work cleared."* (§ "The pre-landing review gate".)
3. **Obligations are checked out-of-band.** The *duty* to escalate / roll back / stay in scope is
   verified by non-agent monitors reading trusted evidence, so a watcher that goes dark or colludes
   (a *missed* flag — the only failure additive-only authority permits) is itself a detectable event
   that fires **past** the watcher straight to the human. (§ "Keeping oversight honest".)

## Three tempos (the third clock)

The loop runs on two clocks because its signals do: a **fast offline** propose→score→learn loop and
a **slow online** shadow→canary→ramp loop (`../loop-orchestrator/README.md` "Two clocks"). Operations
oversight keeps both and **adds a third tempo in front of them** — the *inline, before-land* gate —
because an ops action (a release, a remedy, a mitigation) is consequential the moment it lands, with
no offline rehearsal stage to catch it first. The three tempos are qualitatively different and each
reuses a mechanism the loop already proved:

| tempo | trigger | what runs | reuses | most load-bearing at |
|---|---|---|---|---|
| **Inline** (synchronous, before-land) | a consequential action is about to land | the pre-landing review gate: deterministic tier-derivation + an additive-only reviewer | the loop's risk-tier gate (`../loop-orchestrator/risk_tier_derivation.md`) | **Tier 1** — lets routine prod ops be safe without a human on each action; **and irreversible-effect actions at any tier** (only the before-land tempo can prevent, not just detect) |
| **Continuous** (real-time, event-driven) | an out-of-band signal crosses a bound | circuit breakers + obligation monitors on the agents themselves; revert/contain first, surface after | the loop's circuit breakers (`safety_and_governance.md` §3) | **Tier 0–2** harm conditions on **reversible** actions; collusion / missed-duty detection |
| **Periodic** (scheduled, batch) | a cadence elapses | the manager's oversight **sweep** over the ledger (frequent) + the human supervisor's **meta-review** (slow) | the standing loop supervisor (`safety_and_governance.md` §5) | drift, scope-creep, collusion patterns, and judgment-defined misses no single action's gate sees |

The inline gate is the new piece, and it is the one that buys the whole operating principle: it is
*why* Tier-1 actions need no human. Reserve humans for Tier 2–3 (`shared_operating_discipline.md`
§4) only works if Tier-1 actions are caught *before they land* by something cheaper than a human —
that something is the inline gate. The split also fixes a real limit of the continuous tempo: a
monitor *detects* after the fact, so **prevention of an irreversible-in-effect action** (a sent
message, a hard-to-claw charge) is the inline gate's job — reversibility is a precondition to act
(`shared_operating_discipline.md` §1), and the continuous monitor is the backstop for reversible
harm and for *missed* inline catches, never the primary guard against irreversible harm.

## The build-and-oversee control loop (every role runs this)

A role does not "act"; it runs a control loop, and **the oversee steps are inside the build loop,
not a separate system bolted on**. One iteration, for any consequential action by any role:

```
 sense ──► decide ──► [GATE] ──► act ──► verify ──► ledger
   │          │          │         │        │          │
   │          │          │         │        │          └─ append signed, hash-chained, idempotent
   │          │          │         │        │             (L0; `shared_operating_discipline.md` §5)
   │          │          │         │        └─ confirm intended effect from TRUSTED evidence;
   │          │          │         │           intended≠observed is an incident, not a success
   │          │          │         └─ only reversible, gated actions land; the landing is keyed
   │          │          │            (action_ref × effect-hash) so a crash-retry cannot double-land
   │          │          └─ INLINE OVERSIGHT: derive tier from the action's actual blast radius
   │          │             (not the claim); deterministic-gate clearance (the floor) + additive-only
   │          │             reviewer; human gate if Tier 2; block+escalate if Tier 3 (the four exceptions)
   │          └─ choose an action; self-assign a tier — a CLAIM, checked at the gate, never trusted
   └─ read the TRUSTED signal stream for its domain — never its own self-report (`shared_operating_discipline.md` §2)
```

- **"Build"** is `sense → decide → act` — the role doing its job.
- **"Oversee"** is `gate → verify → ledger` plus the continuous breakers/monitors and the periodic
  sweep wrapped around it. Oversight is not a reviewer standing outside; it is steps *in* the loop
  that read trusted evidence and can only stop, never bless.

`verify` is the inline analogue of the loop's surprise check (`../loop-orchestrator/loop_architecture.md`
"The surprise check"): a divergence between what the agent intended and what the trusted record
shows actually happened is an integrity incident (the ops analogue of `INTEGRITY.SELF_REPORT_DIVERGENCE`),
not a quietly swallowed retry.

## The pre-landing review gate (inline / before-land)

This is "agent-reviews-agent before work lands," and its design is governed entirely by the
additive-only asymmetry. The gate has two parts, in order, and **both must produce a record — the
agent review never substitutes for the deterministic clearance** (the floor is the safety property;
an inline `oversight_record` from an agent reviewer carries a `floor_clearance_ref` to the
`deterministic_gate` record it rides on top of, pinned in the schema):

1. **Deterministic tier-derivation (the floor).** The action's `risk_tier` is derived from a static
   analysis of the **action's actual blast radius** — not the role's self-assigned tier, exactly as
   the loop derives a candidate's tier from the diff rather than the proposer's declaration
   (`../loop-orchestrator/risk_tier_derivation.md`). An under-declaration (claimed tier < derived
   tier) is auto-rejected and escalated as an evasion signal — same rule as the loop's Step 4. This
   step is **deterministic code, signed by an L0 key no agent process holds** (§ "Making the floor
   un-authorable"); it is the only thing that can return *cleared*.
   - *Operational actions need their own surface map.* "Blast radius of a remedy / a mitigation" is
     not a code diff, so the loop's path→surface map does not directly apply. The ops analogue is an
     **action-type → surface / scope map** — trusted config, human-maintained, outside every agent's
     write scope, the operational twin of `risk_tier_derivation.md`'s surface map. Building it is a
     named dependency of this gate; without it, derived-tier and `SCOPE_EXCEEDED` are not computable.
2. **The reviewer agent (additive recall on top).** A peer agent reviews the action against context
   a fixed gate can't encode (does this remedy fit the spirit of policy? does this mitigation match
   the situation?). It is the operational analogue of the proposer: *creative, high-recall,
   non-authoritative.* Its **entire** allowed output is to **raise** scrutiny — `flagged`, `blocked`,
   `tier_raised`, `escalated`. It **cannot** emit `cleared`, cannot lower a tier, cannot approve past
   the deterministic gate. (Pinned in the schema: an agent reviewer's `verdict` enum excludes
   `cleared`.)

Then by derived tier (`shared_operating_discipline.md` §4):

| derived tier | inline path |
|---|---|
| **0** | deterministic gate → act → log. Reviewer **sampled by L0** (not by the manager), so a colluder cannot choose which actions skip review. |
| **1** | deterministic gate → reviewer (additive) → act → log → human *notified* (recorded, per `loop_architecture.md`). |
| **2** | deterministic gate → reviewer → **human approval gate** → act → log. The reviewer assembles the packet; the human decides (`safety_and_governance.md` §5). One approval binds one landing (§ "Crash and recovery"). |
| **3** | **blocked** — the four human-reserved exceptions. The agent contains/freezes/recommends and opens an `escalation_record`; it never lands the crossing (`human_reserved_boundary.md`). |

Four non-negotiable properties of the reviewer, all pinned in `schemas/oversight_record_schema.json`:

- **Non-self-review.** The reviewer is never the acting agent. An agent grading its own work is the
  self-report failure the whole integrity discipline exists to forbid (`shared_operating_discipline.md` §2).
- **Independent evidence — and substantiated.** The reviewer reads trusted / out-of-band evidence
  (the `read_from` enum), never the actor's self-report. *That it actually did so is verifiable, not
  self-asserted:* `evidence.receipt_ref` must resolve to a fresh, signed read-receipt from the
  trusted source, or the record is `INTEGRITY.EVIDENCE_UNSUBSTANTIATED` — the same "don't trust the
  component's account of itself" rule applied to the reviewer's own account of what it read.
- **Deterministic, acyclic-aware assignment.** The reviewer is assigned by mechanism (by L0, not by
  the actor or the manager), drawn from a pool / rotated so no fixed actor↔reviewer pair entrenches,
  **and the assigner avoids composing a directed review cycle** (A→B→C→A) within a window — rotation
  alone does not prevent a self-covering cycle. Crucially, the deterministic floor does **not** depend
  on the assignment being honest: even a colluding reviewer can only *fail to flag*, which the floor +
  obligation monitors still catch.
- **Provenance-checked evidence.** Two "independent" reviews whose evidence shares a poisoned ancestor
  are not independent. `evidence` carries a content-addressed provenance ref; a shared compromised
  ancestor across reviews is `INTEGRITY.SHARED_EVIDENCE_ANCESTOR`.

## The who-watches-whom graph (a DAG that bottoms out, not a cycle)

Oversight is **not** "A watches B watches C watches A" (a cycle is just mutual collusion) and **not**
an infinite tower. It is a short, flat DAG whose every layer is anchored downward to a non-agent
floor:

```
 L4  human supervisor ......... periodic ledger meta-review + the 4 Tier-3 exceptions
        ▲  (on cadence; immediately on any Tier-3 escalation)   [ONLY place the rules/objective change]
 L3  operations_manager ....... routes · prioritizes · pauses a thrashing role · freezes · (L0 assigns reviewers)
        ▲  (continuous + sweep)                                 [NEGATIVE authority only; cannot bypass L0; is subject to L0]
 L2  peer reviewer agent(s) ... inline, additive recall — flag / block / raise-tier / escalate
        ▲  (per consequential action, before-land)              [cannot clear / approve / lower / widen]
 L1  acting agent ............. senses trusted stream · decides · self-assigns a tier (a CLAIM)
        ▲
 L0  THE FLOOR (non-agent — the fixed point, needs no watcher; un-authorable by construction)
      • deterministic tier-derivation from actual blast radius (not the claim), signed by an L0 key
      • deterministic gates over TRUSTED evidence (not self-report); reviewer assignment + Tier-0 sampling
      • out-of-band circuit breakers + obligation monitors  ──► fire PAST L3, straight to L4
      • append-only hash-chained WORM ledger, outside every agent's write scope
      • the trusted-evidence CHANNEL itself (feed config, credentials, signing keys) — Tier-3, agent-unwritable
```

How to read it, and why it terminates:

- **Authority to *stop* increases upward; authority to *change the rules* exists only at L4.**
  L1 acts; L2 can only stop; L3 can only stop/route/freeze; L4 is the sole place scrutiny can be
  *removed*, a tier *lowered*, or the objective/policy *changed* (the operational Tier-3 of
  `shared_operating_discipline.md` §4).
- **Trust flows down, not up.** Each layer's correctness is anchored to L0's trusted evidence, not
  to the honesty of the layer above it. That is the precise reason the regress is finite: you never
  need to trust a higher watcher, because every check re-grounds at L0.
- **L0 is not an agent.** It is human-maintained code + a WORM substrate outside every agent's write
  scope — the same firewall the loop draws around its graders and ledger
  (`safety_and_governance.md` §1, §7). It is the fixed point; it does not need watching in the way an
  agent does, because nothing in the operating loop can author it. *The whole argument depends on
  that last clause actually holding in production* — the next section makes it hold.

### The operations_manager is the apex coordinator — and has no clearing power

The manager looks like a single point of capture (it routes everything, can pause roles, freezes
state, maintains the ledger). It is not, because its authority is **strictly negative**:

- It can `route`, `prioritize`, `pause` a role that is tripping breakers, and `freeze` affected
  state. It **cannot** `clear` work, `approve` a remedy, `widen` a budget envelope, change risk-tier
  policy, `bypass` a gate, **assign reviewers** (that is L0, so the manager cannot hand a colluder a
  friendly reviewer), or **choose which Tier-0 actions skip review** (L0 samples). Those are Tier-3 /
  human / L0 (`agent_roster.md` operations_manager guardrails; `shared_operating_discipline.md` §4).
- It "maintains the ledger" only by **appending** to a store outside its own write scope; entries
  are signed and hash-chained, so it can neither delete, rewrite, nor forge a `decided_by`
  (`shared_operating_discipline.md` §5).

Because the manager has no *positive* authority, there is **no "manager cleared bad work" failure
mode**. But negative authority can be *weaponized* into a net reduction of scrutiny, so two abuses
are themselves overseen, not assumed away:

- **`pause`/`freeze` is a first-class overseen action.** A freeze is a *write to what the out-of-band
  stream observes* — pause the role whose actions would emit a breaching signal and the monitor goes
  quiet. So every manager `pause`/`freeze` produces its own `oversight_record`, and a freeze that
  suppresses an expected out-of-band signal, or a freeze rate above a horizon-derived bound, routes
  **past the manager to L4 immediately** — not at the next sweep.
- **Over-pausing to coerce a human is a recognized signature.** The manager can manufacture an
  availability crisis (pause critical roles mid-wedding) so the only fast path a human sees is to
  relax a control — converting its negative authority into coercion of L4's *positive* authority. An
  L4 action taken under a manager-induced availability anomaly is flagged for retrospective review;
  the human approving under duress is a known coercion pattern, not a clean Tier-3 decision.

## The manager's oversight loop (continuous + periodic)

The manager runs the same `sense → decide → act → verify → ledger` control loop as every role — its
*subject* is the roster's behavior rather than a product domain (a control loop over control loops),
but it is still just an L3 agent with negative authority bottoming out at L0.

- **Continuously**, it consumes the breaker stream and the ledger append stream. A role tripping
  breakers repeatedly is `paused` (reversible) and a cooldown applied — the ops analogue of the
  loop's post-rollback capability cooldown (`safety_and_governance.md` §6). Any `escalation_record`
  opened is `routed` to the right human owner (`schemas/escalation_record_schema.json` `human_handoff`).
- **Periodically (the sweep)**, it scans the ledger for what no single action's gate can see:
  under-declared tiers, missed escalations, self-report divergences, a role drifting toward its
  guardrails, cooldown violations, suspicious reviewer-assignment / freeze patterns. Findings are
  written as `oversight_record`s (`review_kind: periodic_sweep`) and the consequential ones routed to L4.

The manager **never** grades its own oversight performance; L4 does, from the same append-only
ledger the manager cannot rewrite, and the obligation monitors that watch *the manager* run at L0,
not under it.

## Making the floor un-authorable in production (the eval→prod boundary)

Everything above rests on L0 being evidence no agent can author. In the **eval harness** that is true
by construction: the trusted recorder is an out-of-band interceptor of the product's *sandboxed*
effects (`../telemetry/README.md` "Integrity") — the product calls a stub and the harness records
what actually hit it; there is no reach-around. **In production there is no sandbox.** The "out-of-band"
signals are the *real* payment processor, vendor API, health endpoint, and complaint channel, reached
over network connections with credentials, endpoints, and webhook configs — and those are administered
by two of the watched agents (`security_agent` owns secrets/rotation/traffic-blocking; `reliability_agent`
owns health signals/failover — `agent_roster.md`). So the slogan "evidence the actor cannot author"
does **not** transfer for free: an agent need not forge the payment ledger (it can't); it can degrade
*what the monitor receives as* the ledger — point it at a stale replica, narrow an allowlist so the
complaint webhook silently drops, rotate a health credential and never re-provision the monitor, fail
over to a region whose feed isn't wired. This is the project's #1 finding pushed one level deeper:
the loop learned to protect the grader's **inputs**, not just its code; production oversight must
protect the inputs' **channel, provenance, and liveness**.

Three mechanisms make L0 actually un-authorable, each the production twin of an existing rule (fully
specified in `trusted_evidence_channel.md` + `schemas/trusted_feed_schema.json`):

- **The evidence channel is a Tier-3 surface.** The monitors' feed config, source endpoints, and
  credentials are human-maintained and **outside `security_agent` / `reliability_agent` write scope** —
  exactly as the graders live outside the proposer's write scope (`safety_and_governance.md` §1). An
  agent can rotate the credentials it *uses*; it cannot rewrite the credentials the *monitor* reads
  from, nor repoint the monitor's source.
- **Liveness is asserted; absence-of-signal fails closed.** Each out-of-band feed carries a signed
  freshness/sequence assertion from the third party. A monitor whose feed is stale beyond its
  harm-horizon does **not** read silence as safety — staleness is itself an obligation violation
  (`INTEGRITY.TRUSTED_FEED_STALE`) routed to L4. (A breaker fed by a feed it can't confirm is live is
  not a breaker.) Where feasible, a critical signal is cross-checked across **two independent**
  out-of-band sources, so degrading one is itself detectable.
- **L0/L4 signing keys are outside every agent process.** `decided_by` is only as trustworthy as the
  key that signs it (`safety_and_governance.md` §7). If the `deterministic_gate` ran in the manager's
  trust domain, the manager could sign a `cleared` and the additive-only `allOf` would be decorative.
  So the gate / breaker / monitor signing keys live in the **L0 substrate outside every agent's
  process boundary** (the boundary the ledger store already sits behind), and the `human` (L4) key is
  human-held and never available to any agent. A `cleared` whose signature doesn't verify against the
  L0/L4 keyring is `INTEGRITY.FORGED_CLEAR`.

Honest residual: you cannot sandbox the real payment processor, so production trusted-evidence is
*defended*, not *constructed* — by walling its channel (Tier-3), asserting its liveness (fail closed),
cross-checking independent sources, and keeping L0's keys un-authorable. That is the strongest form
the property can take outside a sandbox, and it is the precondition for the regress argument to hold
in production rather than only in eval.

## Keeping oversight honest (no infinite regress, and collusion has no clearing path)

The single new attack surface operations adds over the single-proposer loop is **collusion**: the
loop had *one* creative agent behind a wall; the roster has *six* that interact and could, in
principle, cover for one another. The structure defends it — but the defense is *additive-only +
out-of-band detection*, not "the reviewers are independent so collusion can't happen" (rotation
*reduces* entrenchment; it does not *eliminate* a patient 3-cycle, which is why assignment is
acyclic-aware and evidence is provenance-checked, above):

- **Collusion can only suppress a flag, never clear work.** Additive-only authority means the worst
  a colluding coalition achieves is *no review* — which falls through to the deterministic floor (L0).
  No coalition of agents can forge L0's signed evidence, sign as a non-agent decider, or rewrite the
  hash chain. There is no path by which agreement among agents yields *positive* authority.
- **A missed duty is detected out-of-band and escalates *past* the colluders.** Obligation monitors
  are non-agent code (L0) reading trusted evidence; they check the *duties*, not the agents' reports.
  Crucially, an obligation monitor can only verify a duty whose breach has an **out-of-band signature**:

  | obligation monitor (out-of-band) | the violation it makes detectable | trigger class | the ops integrity code |
  |---|---|---|---|
  | every **effect-defined** Tier-3 trigger in the trusted stream has an `escalation_record` in its horizon | a missed / suppressed escalation (over-envelope charge, double-book, exfil IOC) | effect-defined | `INTEGRITY.MISSED_ESCALATION` |
  | every breaker trip has a corresponding ledgered rollback/containment | a swallowed breaker | effect-defined | `INTEGRITY.UNLEDGERED_ACTION` |
  | a role's cumulative actions stay within its declared scope (needs the action→scope map) | a role quietly expanding authority | effect-defined | `INTEGRITY.SCOPE_EXCEEDED` |
  | the reviewer ≠ the actor on every inline review | a self-review (or forged reviewer) | structural | `INTEGRITY.REVIEWER_WAS_ACTOR` |
  | feeds are fresh; clears verify against the L0/L4 keyring; evidence receipts resolve | a degraded feed, a forged clear, an unsubstantiated review | structural | `INTEGRITY.{TRUSTED_FEED_STALE,FORGED_CLEAR,EVIDENCE_UNSUBSTANTIATED}` |

  These are the **operational analogues** of the loop's `INTEGRITY.SELF_REPORT_DIVERGENCE` — that one
  code is defined in `../eval-harness/rubrics/gate_checks.md`; the ops codes above are **new, defined
  here and in `schemas/oversight_record_schema.json`**, modeled on it (not pre-existing in
  `gate_checks.md`). A violation fires its own escalation on a path that **does not route through the
  `operations_manager`** — straight to L4 — so the manager (or any L2/L3 agent) going dark cannot
  suppress the alarm about itself.

- **Detection halts; it does not page-and-wait.** Humans are on four exceptions, not watching
  dashboards (`human_reserved_boundary.md`), so "route to L4" is **contain-first**: a violation — or a
  stale feed, or a dark monitor — reaches a safe state *automatically* (the breaker discipline,
  `safety_and_governance.md` §3), and the human is woken for *recovery/ratification*, not to *trigger*
  containment. The monitors are themselves liveness-checked: a detector going dark is
  `INTEGRITY.MONITOR_DARK` and halts what it guards, so there is no silently-unmonitored window. This
  recursion bottoms out at the L0 substrate's own attested liveness — the same fixed point as the keys
  (`trusted_evidence_channel.md` "The monitors are themselves monitored").

- **Judgment-defined triggers are not the monitor's job.** Three of the four exceptions have a
  *classification* component — "credibly-suspected breach" (`security_agent`'s judgment), "legal
  threat" / "acute distress" (`support_agent`'s judgment of an inbound message). A captured agent that
  *misclassifies* real harm as routine leaves **no out-of-band trigger** for `MISSED_ESCALATION` to
  match. So classification-defined triggers get a different control, reusing the additive-only
  asymmetry: an independent **raise-only redundant classifier** at the inline gate (a deterministic
  lexicon / breach-IOC tripwire reading the same independent inbound stream) that can only *force* an
  escalation, never clear one — so a single captured classifier is overridden — plus the periodic
  human meta-review over the inbound stream for the residual. `MISSED_ESCALATION` covers
  *effect*-defined triggers; it is **not** claimed to cover judgment-defined ones, and the spec says
  so rather than letting the gap masquerade as total coverage.

- **The rules the oversight enforces are Tier-3.** Oversight is walled off from its own objective
  exactly as the proposer is: it cannot edit the tier policy, the action→surface map, the obligation
  set, the graders, the evidence-channel config, or the ledger store. Changing what oversight enforces
  is a human conversation, never the oversight quietly relaxing itself (`safety_and_governance.md` §1).

So the tower is short: **L0 (non-agent floor) → L1 acts → L2/L3 can only stop → L4 owns the rules.**
No layer above L0 can weaken L0; no agent can author L0's evidence (once the production channel is
walled); a watcher that fails is caught by L0, not by a higher watcher. That is the whole resolution.

## Cadences — pinned to a trigger and a horizon, not a magic number

Cadence numbers depend on the same standing input the loop's power analysis does — the couple
arrival rate (`../loop-orchestrator/experiment_design.md`) — and the harm horizons of the production
signals, neither of which a spec invents from thin air. So each tempo is pinned by its **triggering
basis** and the **signal horizon it must cover**, and the number is derived from those at build time:

- **Inline** — not a period: triggered by the action itself, blocking, before-land. Latency budget
  must be below the action's commit deadline (a wedding-day remedy cannot wait on a slow review).
- **Continuous** — event-driven on the out-of-band stream; its detection latency must be shorter
  than the harm's doubling time (a breaker that fires after the harm has spread is not a breaker —
  `safety_and_governance.md` §3), and shorter than each feed's freshness horizon (a feed gone stale
  fails closed before its silence could mask harm).
- **Periodic — manager sweep** — frequent enough that a drift/scope-creep/freeze-abuse pattern is
  caught within a small multiple of the fastest obligation horizon; bounded below by sweep cost.
- **Periodic — human meta-review** — the standing supervisor cadence (`safety_and_governance.md`
  §5), slow (the human reviews *patterns* and the judgment-defined residual, not actions), plus
  **immediate** on any Tier-3 escalation or out-of-band obligation violation.

Stating the basis rather than a number is deliberate: a hard-coded cadence that outlives the arrival
rate it was sized for is a silently-stale guarantee — the same discipline `experiment_design.md`
applies to power and duration.

## The product loop is the worked example, not a second system

`product_improvement_loop` is already fully overseen by its own funnel — offline accept rule → tier
gate → shadow/canary/ramp → breakers (`../loop-orchestrator/`). That funnel **is** its inline +
continuous oversight; it already conforms to everything above. Operations oversight therefore adds
**nothing parallel** for it — only (a) the **periodic sweep** over its ledger (which the human
supervisor already performs, `safety_and_governance.md` §5) and (b) the **obligation monitors** (e.g.
its surprise-check firing must produce a routed review). This honors "one pattern set, not two"
(`shared_operating_discipline.md`): the loop is not re-overseen, it is the generalization's first
instance, and the other five roles copy its shape.

## Crash and recovery (the oversight must survive its own death)

Oversight is a long-running controller, so what happens when an oversight process dies mid-iteration
is first-class — but the loop's recovery reasoning **does not transfer wholesale**, and the
difference is load-bearing. The loop's "a crash before ledger-append leaves only a discardable
worktree" (`../loop-orchestrator/loop_architecture.md` "Failure and recovery") holds because the
loop's pre-ledger artifact is a *sandboxed worktree*. An ops `act` is a **real deploy / charge /
send** — not discardable. So:

- **The landing is keyed to its effect, checked against the out-of-band record.** Every action
  carries an idempotency key (`action_ref × intended-effect-hash`). On restart, "did *this* effect
  already land?" is answered from the **third-party out-of-band record** (the processor's charge
  ledger, the vendor's confirmation), not from the agent's memory — so a crash between `act` and
  `ledger` is reconciled against reality, and a re-driven turn cannot double-land. A Tier-2 action
  binds **one `human_gate.approved` to one landing** via that key, so a crash cannot re-spend an
  approval.
- **Fail-safe covers *every* non-terminal transition, not just breaker-last.** Any action with a
  `gate: cleared` but no matching `verify` entry within its commit deadline resolves to
  *rolled-back / contained* (`INTEGRITY.UNVERIFIED_LAND`), never silently to live — generalizing the
  loop's "a candidate whose last transition was a breaker firing resolves to rolled_back."
- **Obligation monitors are stateless replays** over the trusted stream + ledger, so a monitor that
  died re-derives every outstanding duty on restart — it cannot "forget" a missed escalation, because
  it never held the obligation in mutable memory; it recomputes it.
- **Oversight-record appends are idempotent**, keyed by `subject_ref × review_kind × reviewed_by ×
  verdict × evidence_ref` plus the hash chain — including `reviewed_by` and `evidence_ref` so two
  *genuinely distinct* reviewers reaching the same verdict are not collapsed into one record (which
  would erase the redundancy signal the meta-review needs), while a true exact-replay still dedups.

## The oversight_record artifact

Every inline review, monitor trip, sweep finding, and obligation violation is written as an
`oversight_record` (`schemas/oversight_record_schema.json`) that chains into the **same** append-only
hash-chained ledger as `escalation_record` and the loop's `ledger_entry` — so "who reviewed what, on
what trusted evidence, and what they were (and were not) allowed to decide" is permanently and
tamper-evidently reconstructable. The schema pins the gameable properties: additive-only verdicts for
agent reviewers, `cleared` reachable only by `deterministic_gate` / `human`, non-self-review, the
`floor_clearance_ref`, substantiated independent evidence, derived-vs-claimed tier, and the
out-of-band routing of obligation violations.

**`oversight_record` vs `escalation_record` — when you write which.** An `oversight_record` records
an *act of oversight* (a review, a monitor/breaker trip, a sweep finding, a detected missed-duty); an
`escalation_record` records a *hand-off across a human-reserved line* (`human_reserved_boundary.md`).
They are not alternatives: when an obligation monitor catches a *suppressed Tier-3 escalation*, it
writes an `oversight_record` (`review_kind: obligation_violation`, `INTEGRITY.MISSED_ESCALATION`)
**and** opens/repairs the `escalation_record` that should have existed. The former audits the watcher;
the latter is the actual hand-off. Both chain into the one ledger.

## The property all of this protects

A roster of creative, autonomous agents is **safe to run with humans only on the four exceptions**
for the same reason a creative proposer is safe to run without a human in every cycle: not because
some agent is trusted to watch the others, but because **every consequential action is anchored to
evidence no agent can author, reviewed by an authority that can only add scrutiny, and recorded where
no agent can rewrite it.** The eval harness made "evidence no agent can author" true by construction;
production makes it true by walling the evidence *channel* the way the loop walled the grader *code*.
Loosen any one — let a review clear on self-report, give a watcher positive authority, let the watched
rewrite the record, or let an agent quietly administer the evidence that judges it — and "agents
overseeing agents" collapses into "agents agreeing with agents." Keep them, and the team can run
itself, because the cost of a bad action (or a missed flag) is a reverted, ledgered, re-escalated
event — not someone's wedding.
