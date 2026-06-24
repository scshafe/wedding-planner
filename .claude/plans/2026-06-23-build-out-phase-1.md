# Plan: Build-out Phase 1 — the offline core

**Goal:** Stand up the cheap, harmless **offline half** of the system from the design specs: a candidate change can be proposed, scored against the eval corpus over a *trusted* event stream, and the decision written to an append-only hash-chained ledger — with **zero production blast radius** (no real money, bookings, comms, or agents-operating-the-stack).

**Out of scope (explicitly deferred to later phases, gated behind a working offline core):** the production funnel / experiment engine (shadow/canary/ramp), any real money / booking / comms side effects, the `agent-operations/` roster + oversight loops + the *production* trusted-evidence channel, and the full creative model-proposer with exploration. Phase 1 builds the deterministic, harmless filter the design says everything else sits behind (`loop-orchestrator/README.md` principle 2, "cheap filter before expensive risk").

## Operating philosophy (read first)

This project is a **testbed for autonomous agent build-out**: a defining interest of the user's is to
see how well agents build a full-scale system given *general directives + optimization goals + loop
development ability* ([[agents-own-buildout-decisions]]). So **the building agents own the engineering
decisions** — stack, structure, design patterns, sequencing — and record their own rationale. This
plan gives **direction and hard safety rails, not a rigid script**: treat the steps below as a
*recommended* dependency-ordered starting sequence to adapt and amend (the `executing-plans` skill
expects you to amend as reality diverges). The non-negotiables are the **safety rails**, not the *how*:
offline-first (no production money/booking/comms blast radius in Phase 1), reuse the one safety model,
ground every artifact in the specs, and optimize toward the North Star. Minimize human gates on
engineering choices; keep the safety rails firm.

## Context

- The repo is **specs-only** (this is the first build). Four domains, one safety model. Start here: root `README.md`, then `loop-orchestrator/README.md`, `telemetry/README.md`, `eval-harness/README.md`.
- **The #1 principle that shapes the build order:** decisions are made over the *trusted* event stream, never the product's self-report (`telemetry/README.md` "Integrity"; `loop-orchestrator/safety_and_governance.md` §1). So the trusted recorder + ledger + deterministic gates are built *before* anything that could act. The offline core has no production blast radius by construction — it is the safe thing to build first.
- The **12 JSON schemas** (`*/schemas/*.json`) are the canonical contracts; all are draft-2020-12 meta-valid. Treat them as the source of truth — generate types from them, validate at runtime against them, do not hand-redefine them.
- Deeper continuation context is in `.claude/handoff.local.md` and project memory (`MEMORY.md` index): [[north-star-objective]], [[loop-trusted-evidence-boundary]], [[prod-trusted-evidence-channel]].
- The executor should **amend this plan** as it discovers reality (the loop internals in particular are sketched, not guessed — expand them when you get there).

## Steps

- [x] **Step 1: Choose the tech stack & project structure (agent decision — own it).**
  - This is *your* call as the building agent, grounded in the specs and the goal of an agent-operated, schema-contract-driven system. Pick the stack and structure, and **record the decision + rationale** (a short ADR in the repo).
  - Non-binding suggestion (take it or override it): TypeScript + Claude Agent SDK + ajv — the 12 contracts are already JSON Schema, so ajv gives runtime validation and `json-schema-to-typescript` gives static types from the same source, and the Agent SDK (the proposer's substrate, `loop-orchestrator/README.md` "Implementation substrate") is first-class in TS. Python + pydantic is an equally legitimate choice. **Do not stop for human approval — decide, record why, and proceed.**
  - Verify: an ADR recording the choice + rationale exists in the repo.

- [x] **Step 2: Scaffold the project skeleton.**
  - A workspace with one package per domain (`telemetry`, `eval-harness`, `loop-orchestrator`, `agent-operations`), a test runner (e.g. vitest), tsconfig, lint. Follow the `agent-first-engineering` skill conventions.
  - Verify: `npm run build` (tsc, no errors) and `npm test` (empty suite passes) both succeed.

- [x] **Step 3: Wire the 12 schemas as runtime contracts + a validation harness.**
  - Load all 12 `*/schemas/*.json` into ajv (do not copy/redefine them); a test compiles each and validates the existing sample instances (`eval-harness/personas/*.yaml`, `eval-harness/scenarios/**/*.yaml`) against their schemas.
  - Verify: a test asserts all 12 schemas compile under ajv and every sample persona/scenario validates.

- [ ] **Step 4: Generate TypeScript types from the schemas.**
  - `json-schema-to-typescript` over the 12 schemas → typed contracts shared across packages.
  - Verify: `tsc` typechecks; a round-trip test constructs a typed `event_envelope` and `candidate_change` and validates them against ajv.

- [ ] **Step 5: Telemetry substrate — the event stream + metrics as pure functions.**
  - Implement the event envelope/payloads as runtime-validated types and the metric engine where a metric is `f(events filtered by wedding_id)` with **no ambient state/clock** (`telemetry/README.md` "Metrics own no state" / "Determinism"). Implement a handful of `metric_code`s from `telemetry/metric_catalog.md`.
  - Verify: a test replays a fixed event stream twice and asserts identical metric output (replayability); `event_id`/`occurred_at`/`seed` are injected, not read from a clock.

- [ ] **Step 6: The append-only hash-chained ledger.**
  - Implement `ledger_entry` (`loop-orchestrator/schemas/ledger_entry_schema.json`): `entry_hash`/`prev_entry_hash` chaining, append-only, idempotent appends keyed by `candidate_id × from_state × to_state` (`loop-orchestrator/loop_architecture.md` "Failure and recovery").
  - Verify: tests prove (a) altering an earlier entry breaks the chain (tamper-evident), (b) a rewrite is rejected (append-only), (c) a re-driven identical append does not fork history.

- [ ] **Step 7: The eval-harness trusted recorder (the integrity boundary).**
  - Implement the out-of-band trusted recorder that intercepts the (sandboxed) product's would-be effects and authors the TRUSTED fields (`verified`, committed totals), per `telemetry/README.md` "Integrity" and `loop-orchestrator/safety_and_governance.md` §1. The "product" is a sandbox stub in Phase 1.
  - Verify: a test shows a gate reads the trusted record (not a product-emitted field), and a product self-report that diverges from the trusted record raises `INTEGRITY.SELF_REPORT_DIVERGENCE`.
  - Specialist: `doddy` *(this is the project's #1 safety boundary — verify the implementation actually protects the graders' inputs, not just their code).*

- [ ] **Step 8: The deterministic veto gates over the trusted stream.**
  - Implement the gates in `eval-harness/rubrics/gate_checks.md` (`COMMS.*`, `SPEND.*`, `INTEGRITY.SELF_REPORT_DIVERGENCE`, …) as pure functions over the *trusted* portion of the stream.
  - Verify: tests over the golden + adversarial scenarios (`eval-harness/scenarios/**`) assert each gate's expected pass/fail against the scenarios' encoded expected outcomes.

- [ ] **Step 9: The North Star scoring model + grade_report.**
  - Implement the offline accept rule verbatim from `eval-harness/scoring/scoring_model.md` (no golden regression; no new veto/FATAL; no counter-metric regression; aggregate North Star improves with adversarial ≥ golden) producing a `grade_report` (`eval-harness/schemas/grade_report_schema.json`). Treat `north_star_ratio` as the zero-inflated bounded ratio the spec describes (decompose; don't analyze as a raw mean).
  - Verify: a test scores a known candidate across the corpus and asserts the `grade_report` + accept/reject decision matches the rule in `scoring_model.md`.
  - Specialist: `testineer` *(the estimand and the accept-rule oracle are subtle; get the test strategy right).*

- [ ] **Step 10: Wire the offline pipeline end-to-end.**
  - Connect trusted recorder → gates → scoring → ledger: scoring a candidate produces a `grade_report` and an `offline_passed`/`offline_rejected` ledger transition with `decided_by: deterministic_selector` (`loop-orchestrator/loop_architecture.md` stage machine).
  - Verify: an integration test runs one candidate through the whole offline path and asserts the chained ledger entry + the `offline_result` payload.

- [ ] **Step 11: A minimal proposer + the offline loop (stub-first).**
  - A proposer that emits a schema-valid, hypothesis-first `candidate_change` (`loop-orchestrator/proposer_design.md`); a *scripted/stub* proposer is fine for Phase 1 (the creative model-proposer comes once the gate is trusted). Drive the `propose → score → ledger → learn` loop with the loop-until-dry termination (`loop_architecture.md` "Convergence").
  - Verify: an integration test runs the loop on a trivial corpus, scores a stubbed candidate, ledgers the result, and terminates loop-until-dry; `npm test` green.

## Done criteria

The offline core runs end-to-end: a (stubbed) candidate is proposed, scored against the corpus over the trusted event stream, and the decision is written tamper-evidently to the ledger — no production side effects anywhere. Verify: `npm run build && npm test` green, including the step-10 and step-11 integration tests. Final action: commit on a `build/phase-1-offline-core` branch (not `main`) and open it for review.

## Later phases (NOT this plan — each its own plan, gated behind the offline core)

1. The creative model-proposer (real Claude Agent SDK proposer with exploration/diversity).
2. The production funnel — experiment engine, shadow/canary/ramp, the statistical decision rules (`loop-orchestrator/experiment_design.md`). **First real blast radius — heavily gated.**
3. `agent-operations/` — the roster, the oversight loops, the *production* trusted-evidence channel (`agent-operations/oversight_loops.md`, `trusted_evidence_channel.md`).
4. The action→surface/scope map (the named unbuilt dependency for operational tier-derivation).
