# ADR 0001 — Tech stack & project structure for the offline core

- **Status:** accepted
- **Date:** 2026-06-23
- **Decider:** the building agent (this is an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-23-build-out-phase-1.md` Step 1)
- **Scope:** Phase 1 — the offline core only (telemetry substrate → ledger + trusted recorder →
  deterministic gates + North Star scoring → minimal offline loop). No production blast radius.

## Context

The repository is **specs-first**: 12 JSON Schema (draft-2020-12) files under `*/schemas/*.json` are
the canonical contracts, and four domain directories (`telemetry/`, `eval-harness/`,
`loop-orchestrator/`, `agent-operations/`) hold markdown design docs. We are now standing up the
running code for the harmless offline half of the system.

Two facts dominate the decision:

1. **The contracts are already JSON Schema.** Whatever we build must treat those 12 files as the
   single source of truth — validate against them at runtime and derive static types from them,
   never hand-redefine them (root `README.md`; plan Context §3).
2. **The loop's implementation substrate is the Claude Agent SDK** (`loop-orchestrator/README.md`
   "Implementation substrate"), which is first-class in TypeScript. Phase 1 does not build the
   creative proposer, but the stack choice should keep that substrate native for later phases.

## Decision

### Language & runtime: TypeScript on Node (ESM)

TypeScript, ES modules, `strict` everywhere, full type annotations on every public signature
(agent-first convention). Rationale:

- The same 12 schema files feed **both** projections we need:
  - **runtime validation** via `ajv` (2020-12 dialect) + `ajv-formats` — compiled directly from the
    schema files, no copy/redefine;
  - **static types** via `json-schema-to-typescript` — generated from the same files.
  One source of truth, two derived artifacts. This is the agent-first "one capability, one
  implementation, one location" principle applied to the contract layer.
- The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is native TS, so the later creative
  proposer sits on the same stack as the deterministic core that gates it.
- Determinism (inject `event_id`/`occurred_at`/`seed`, never read an ambient clock/RNG —
  `telemetry/README.md` "Determinism") is expressed cleanly with explicit dependency injection.

Python + pydantic was the equally-legitimate alternative; TS wins here purely on the
schema-to-types-and-validation symmetry and SDK nativeness, not on any deficiency of Python.

### Libraries

| concern | choice | why |
|---|---|---|
| schema validation | `ajv` + `ajv-formats` | compiles the draft-2020-12 schemas directly; fastest, strict |
| type generation | `json-schema-to-typescript` | types derived from the same schema files |
| test runner | `vitest` | native ESM+TS, no build step to run tests; fast watch |
| YAML loading | `js-yaml` | personas/scenarios are YAML; loaded then validated against JSON Schema |
| hashing / signing | Node built-in `crypto` | sha256 hash chain + HMAC signatures for the ledger (deterministic) |
| lint | `eslint` + `typescript-eslint` | enforce the conventions machine-side |

### Project structure: one workspace package per domain, specs and code co-located

`npm` workspaces. **Each domain stays exactly one top-level directory** holding *both* its existing
specs (markdown + `schemas/`) *and* its new `src/` + `tests/` + `package.json`. We deliberately do
**not** introduce a `packages/` split that would scatter "the telemetry domain" across two places —
the water-cooler test (agent-first) says "the telemetry code" must resolve to one directory, and the
canonical schemas already live at `telemetry/schemas/`.

```
wedding-planner/
  package.json            workspaces root (private)
  tsconfig.base.json      shared strict compiler options
  tsconfig.json           whole-monorepo typecheck (the `build` gate)
  vitest.config.ts        test runner + package aliases
  eslint.config.js
  docs/adr/               this file and successors
  shared/                 @wedding-planner/shared — cross-domain capabilities
    src/  tests/
  telemetry/              @wedding-planner/telemetry — specs (existing) + src/ + tests/
  eval-harness/           @wedding-planner/eval-harness
  loop-orchestrator/      @wedding-planner/loop-orchestrator
  agent-operations/       @wedding-planner/agent-operations (skeleton only in Phase 1)
```

`shared/` holds capabilities used by ≥2 domains (agent-first: promote to top-level `shared/` rather
than duplicate): the **schema registry / validator** (the one ajv-backed contract checker), the
**generated contract types**, **determinism** primitives (injected clock / id / seed), **structured
logging**, the **base error type**, and **hash-chain/signing** helpers.

### Build & test gates

- `npm run build` = `tsc --noEmit -p tsconfig.json` — typechecks the entire monorepo. This is the
  meaningful "does it compile" gate. Phase 1's runtime is the **test-driven offline core** (steps 10
  and 11 are integration *tests*), and tests run against TypeScript source via `vitest`, so an
  emitting build with runtime module resolution is **not** needed yet and is deferred to the first
  deployable runtime (a later phase). Naming it `build` keeps the verb the plan uses; it is honestly
  a strict typecheck, documented as such here rather than pretending to emit a runnable artifact.
- `npm test` = `vitest run`.
- `npm run gen:types` regenerates `shared/src/contracts/*` from the 12 schemas.

Cross-package imports use the package name (`@wedding-planner/shared`); npm workspaces symlink the
packages, `tsconfig` `paths` resolve them for `tsc`, and `vitest` aliases resolve them for tests —
each tool pointed at `src/` so there is no `dist`/`src` dual-export ambiguity.

## Consequences

- **Positive:** the 12 contracts stay the single source of truth (validated + typed from one place);
  the stack is native to the eventual proposer SDK; determinism is explicit; each domain is one
  grep-scope. Low config surface — no project-reference/composite machinery to go wrong in an
  autonomous run.
- **Negative / deferred:** no emitting build yet, so there is no `node dist/...` entrypoint in Phase
  1 — acceptable because the deliverable is verified by integration tests, but a real emit (project
  references or a bundler) must be added before any deployable Phase-2 runtime. Recorded as a known
  follow-up, not an omission.
- **Signing keys** for the ledger's `decided_by_signature` are an injected config value in Phase 1
  (HMAC). True out-of-process key custody is a production trusted-evidence-channel concern
  ([[prod-trusted-evidence-channel]]) and is explicitly out of scope here.

## Alternatives considered

- **Python + pydantic** — equally valid; rejected only for the weaker schema↔types↔validation
  symmetry and non-native Agent SDK story.
- **`packages/` monorepo split** — rejected; it would split each domain across `telemetry/` (specs)
  and `packages/telemetry/` (code), failing the water-cooler test.
- **TypeScript project references / composite build** — rejected for Phase 1 as needless fragility;
  a single-tsconfig typecheck is simpler and sufficient. Revisit when a real emit is required.
