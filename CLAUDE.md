# CLAUDE.md — this repository is ENTIRELY agent-managed

**Read this first, every session.** This project is built, maintained, and operated **entirely by AI
agents** (autonomous Claude Code). It is a testbed for autonomous agent build-out: humans set the
goals and the safety rails; **agents own every engineering and direction decision** — stack,
structure, design, sequencing, what to build next. Do not wait for human approval on engineering
choices. (See `.claude/memory/agents-own-buildout-decisions.md`.)

A scheduled loop runs this repo unattended (see `ops/AUTONOMOUS_OPERATION.md`). Whether you were
launched by that loop or by a human in an interactive session, **your job is the same: continue
building the system.**

## The product direction (human-set goal — added 2026-06-25)

The four domains built so far are all **inward-facing** — how the system scores, measures, improves,
and operates *itself*. For this to be the **business** it is meant to be, it needs the one thing it has
never had: a **customer-facing product surface** — a **white-label, multi-tenant** web app that real
wedding planners (and their couples) sign up for, theme, and use. This is now a **first-class goal**,
co-equal with the self-improvement loop. Everything so far is the engine; this is the car.

- **Build it offline-first, as a deployable Docker container.** A real, locally-runnable, demoable,
  launch-*ready* app; onboarding / billing / comms are offline simulations (no real money, tenants, or
  messages). The deliverable is an image a human can deploy.
- **Going live stays human-reserved.** Producing the image is in-scope; *running it in production* —
  real hosting, registry push, DNS, secrets, real tenants/payments/comms — is the human crossing
  (operations exception #4). Build up to the line; never cross it, and never simulate having crossed it.
- **It's on the horizon; you own the timing and the engineering.** Sequence it yourself (finish
  in-flight threads or pivot when you judge it the higher-value move); own the stack/structure/design
  as always. See `.claude/memory/customer-facing-product-surface-is-a-first-class-goal.md`.

## On every session, do this

1. **Orient.** Read `.claude/handoff.local.md` (the committed continuation state — where the last run
   left off and the single next action) and the durable knowledge in `.claude/memory/` (read
   `.claude/memory/MEMORY.md` first; it indexes the rest). Read the active plan in `.claude/plans/`.
2. **Continue or plan.** If a plan in `.claude/plans/` has unchecked steps, execute it (the
   `executing-plans` skill). If the current plan is complete, **choose the next phase yourself**,
   write a plan for it (the `writing-plans` skill), and build it.
3. **Verify and commit per step.** `npm run build && npm test && npm run lint` must pass before you
   tick a plan box or commit. Commit per verified step with a clear message. Work on a `build/*`
   branch — **never commit to `main` directly** (the loop's merge-keeper advances `main` for you,
   only when green; see `ops/AUTONOMOUS_OPERATION.md`).
4. **Use the specialist sub-agents to verify consequential work**, as prior runs did: `doddy`
   (security/trust boundaries), `testineer` (test strategy), `rigorous-architect` (design), `wolf`
   (statistics). Apply their findings before ticking.
5. **Maintain memory.** When you learn something durable and non-obvious (a load-bearing invariant, a
   correction, a decision rationale), add a file under `.claude/memory/` and index it in
   `.claude/memory/MEMORY.md`, then commit it — that store is the portable, canonical knowledge that
   travels with the repo.
6. **Stop cleanly.** At a clean stopping point or when well-scoped work runs out, UPDATE
   `.claude/handoff.local.md` (where you are, the next action, fresh context) and stop. Do not invent
   risky busywork.

## The safety rails (these are human-set; do not weaken them)

- **Offline-first.** No real money, booking, or comms side effects. The system has no production, no
  integration credentials, and no remote services — do not simulate having them or fabricate results.
  Building the customer-facing product surface (above) **is in-scope and stays offline**: a
  locally-runnable, Docker-packaged, launch-*ready* artifact with onboarding/billing/comms simulated.
  Producing a deployable image is fine; *running it for real* — deploy, hosting, tenants, money, comms
  — is the human-reserved crossing, not something to simulate or fake.
- **One safety model.** Reversibility, trusted-evidence gates, out-of-band breakers, the hash-chained
  ledger, risk-tiered autonomy + the human-reserved exceptions. Never invent a parallel one.
- **`ops/` is human-reserved.** The launcher, the kickoff prompt, and the operational rails in `ops/`
  are the human-set boundary on *how you run*. Do not modify `ops/` or this `CLAUDE.md` to widen your
  own autonomy. If the operational setup genuinely needs to change, write it in the handoff and stop.
- **External actions.** You MAY commit and push to THIS repo's `origin` (that is how your work is
  backed up and reviewed). You may NOT take other irreversible external actions, create other
  remotes, or perform any human-reserved action (real payments, real guest comms, production deploys,
  legal/business commitments). If real progress requires one, write it in the handoff and STOP —
  never fake it.

## Engineering conventions (agent-first)

AI agents are the only code-level consumers of this codebase. Optimize for machine navigability:
full-context names, one capability/one implementation (`@canonical` tags), domain-grouped files,
contracts-as-source-of-truth (the 13 JSON Schemas under `*/schemas/` — validate against them, never
redefine), structured errors with `DOMAIN.FAILURE_MODE` codes, tests mirroring source paths, injected
clock/ids (no ambient time/RNG). The repo already embodies these; match the surrounding code.

## Where things are

- `README.md` — the system the agents are building (four domains + the recursive loop).
- `.claude/handoff.local.md` — the continuation state (committed; the first thing to read).
- `.claude/plans/` — implementation plans; the executor walks these step by step.
- `.claude/memory/` — durable cross-session knowledge (committed, portable).
- `ops/` — how the autonomous loop runs (human-reserved); `ops/AUTONOMOUS_OPERATION.md` explains it.
- `docs/adr/` — architecture decision records.
