# AGENTS.md — wedding-planner

The agent contract for this repository. `CLAUDE.md` imports it (`@AGENTS.md`); references to
"CLAUDE.md" in the README, plans, memory and the Dockerfile mean this file.

## The project at a glance

- **What it is:** an AI wedding planner. An npm-workspaces TypeScript monorepo (`shared`,
  `telemetry`, `eval-harness`, `loop-orchestrator`, `agent-operations`, `product`) run directly by
  `tsx` (no emitted JS). `app/server.ts` serves the multi-tenant, white-label planner console + JSON
  API (`/healthz` is the liveness route). A scshafe-dev `service` project (`dev.toml`).
- **Run:** `npm ci`, then `npm run serve` (`PORT` 8080, `HOST`, `WP_SEED_DEMO`, `WP_OPERATOR_TOKEN`).
  The image: `scripts/docker_build.sh`, recipe in `docs/RUNNING_THE_IMAGE.md`. Node >= 20
  (`engines`); the production image is `node:22-slim`.
- **Verify:** `npm ci && npm run typecheck && npm run lint && npm test` (`dev.toml [verify]`;
  `.github/workflows/ci.yml` runs the same on Node 22). It is the same gate as
  `scripts/conductor-gate.sh test` and the loop's `npm run build && npm test && npm run lint`
  (`build` is the same `tsc --noEmit`). GitHub Actions does not run for this private repo today
  (account billing), so run it locally before proposing a merge.
- **Production:** `dev.toml [deploy]` lane `autodeploy`, stack `wedding-planner`, host `lubuntu`.
  **Merging to `main` deploys:** Lubuntu's mc-autodeploy (5-minute timer) fast-forwards its
  `~/src/wedding-planner` checkout and the Conductor runs `tools/stack deploy wedding-planner`
  (builds the root Dockerfile, pins `WEDDING_PLANNER_IMAGE_TAG`, `compose up`, checks `/healthz`,
  rolls back on failure). It serves tailnet-only at `https://wedding-planner.colobus-stargazer.ts.net`
  (deployed on the operator's explicit call, 2026-08-13). State is in memory only: every deploy or
  restart resets to the demo seed. CI never deploys (SERVICE-02); nothing here pushes images.
- **Secrets:** `WP_OPERATOR_TOKEN` and `WP_PROVIDER_WEBHOOK_TOKEN` (>= 16 characters, fail closed)
  live only in the stack's `.env` on Lubuntu: never in the repository, the image (no `ARG`/`ENV`),
  CI or tests. CI has only its read-only job token; tests use injected fakes, no real services.
- **Related:** `~/src/infra` `stacks/wedding-planner/` (compose, tailnet serve config),
  `autodeploy/README.md` (mc-autodeploy) and `NEW-SITES-RUNBOOK.md` §3; `docs/adr/` (decisions);
  `ops/` (the autonomous loop, human-reserved); `.claude/` (handoff, plans, memory).

---

## The operating contract (moved from CLAUDE.md) — this repository is ENTIRELY agent-managed

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

**A named capability on this roadmap (human-set 2026-06-26) — a guest-facing messaging channel.** Wedding
guests text the AI (SMS / WhatsApp / …) to get info, updates, and answers (RSVP, logistics, Q&A). The
guest↔AI Q&A loop is already modeled and scored inward (`qa_accuracy`); what's missing is the product
channel (guests aren't a product persona yet) + the provider boundary. **Two human-set design
constraints, non-negotiable:** **(1) pricing is a first-class factor** — messaging is metered, so meter
per-message usage and price it with margin (extends the flat-monthly `price_book` + the Phase-15 ledger),
*and* make per-message cost a North-Star denominator term so the comms strategy (cadence/spacing/batching)
trades real money; **(2) avoid vendor lock-in** — the provider sits behind a provider-agnostic port
(send/inbound/delivery-status/cost-report) with swappable, offline-**simulated** adapters and no
carrier-specific concepts in the domain. Build it offline and demoable; a real provider sending real texts
is the human-reserved crossing (guest comms is tier-2). See
`.claude/memory/guest-messaging-channel-is-a-roadmap-goal.md`.

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
  are the human-set boundary on *how you run*. Do not modify `ops/` or this `AGENTS.md` to widen your
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

## Agent identity

This repository has its own agent user, `agent-wedding-planner`, on the owner's
Arch workstation (scshafe/infra `docs/platform/agent-identity.md`). It works in
its own clone and commits, opens PRs and merges as `scshafe-agent[bot]`, with
one-hour tokens for `scshafe/wedding-planner` only. Merging to `main` deploys
(mc-autodeploy), exactly as for the owner.

<!-- scshafe-dev:begin landing -->
## Verify and landing

Managed by scshafe-dev: `dev adopt` and `dev update` refresh this section from `dev.toml`; change `dev.toml`, not these lines.

Before finishing, both of these must pass:

```sh
npm ci && npm run typecheck && npm run lint && npm test
dev check .
```

How a change lands:

1. Work on a branch and open a PR.
2. Run the two commands above. If the repository is private, GitHub Actions does not run for it: verify locally and say in the PR what you ran. If it is public, wait for CI to be green.
3. Merge your own PR with a merge commit, one change at a time: `gh pr merge <N> --merge --subject "Merge #<N>: <title>"`. Never squash or rebase (both are off on the repository), and pass `--subject`: `gh pr merge` does not make the `Merge #N: <title>` subject by itself.

The project's agent may merge its own PR and push `main`; there is no approval gate.

Merging deploys to production ([deploy] lane `autodeploy`: Lubuntu's mc-autodeploy redeploys `main`).
The agent cannot observe the deploy from its sandbox (no tailnet access). After merging, say so in your reply and name the merge commit, so the owner session watches the deploy.
<!-- scshafe-dev:end landing -->
