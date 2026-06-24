# Autonomous operation

This repository is **built, maintained, and operated by an autonomous Claude Code loop.** This
document explains how the loop runs and how to deploy it on a headless server. The files in `ops/`
are the **human-set operational rails** — the autonomous agent does not modify them (see `CLAUDE.md`).

## What one run does

A scheduler fires `ops/run.sh` every ~3 hours. Each run:

1. Takes a single-flight lock (skips if a previous run is still going; self-heals a hung lock).
2. Runs `claude` headless from the repo with `ops/kickoff-prompt.md`. The agent reads
   `.claude/handoff.local.md` (the continuation state) + `.claude/memory/`, then **continues the
   active plan or writes and builds the next phase itself** — committing per verified step on a
   `build/*` branch.
3. **Merge-keeper:** fast-forwards `main` to the build-branch tip, but **only if** the tree is clean
   AND `npm run build && npm test && npm run lint` all pass. So `main` only ever advances to a green,
   verified state, and never drifts more than one run behind.
4. **Pushes** `main` and the build branch to `origin`.

The whole loop is **offline and deterministic by construction**: the system has no production, no
integration credentials, and no external side effects. The worst case of a bad run is a revertible
commit on a branch — never a real-world action.

## Safety model (why this is safe to run unattended)

- **Agents own the buildout; humans own the rails.** The agent decides what to build and how; humans
  set the goals and the constraints in `CLAUDE.md` + `ops/`. The agent does not modify `ops/` or
  `CLAUDE.md`.
- **`main` is always green.** The merge-keeper re-verifies build+test+lint before advancing `main`.
- **Everything is revertible.** Per-step commits on a branch; `main` only fast-forwards.
- **Offline-first.** No real money, booking, comms, deploys, or other irreversible external actions.
  The only external action the loop takes is `git push` to this repo's `origin`. If real progress
  needs a human-reserved action (credentials, real comms, production), the agent writes it in the
  handoff and stops rather than faking it.
- **Specialist verification.** Consequential work is adversarially reviewed by sub-agents (`doddy`
  for security, `testineer` for tests, etc.) before it lands.

## Deploy on a headless server

### Prerequisites
- **Git** + an SSH key on the server authorized for this repo (`git@github.com:scshafe/wedding-planner.git`).
- **Node.js 20+** (for `npm`).
- **Claude Code CLI**, authenticated non-interactively. Install per the official docs, then
  authenticate so headless `claude -p` works without a prompt — either a subscription login that
  persists (`claude login` once, interactively, on the server) or an API key in the environment
  (`ANTHROPIC_API_KEY`). Verify with:
  `claude --dangerously-skip-permissions -p "say OK" </dev/null` → prints `OK`.
- **The specialist sub-agents and workflow skills the loop relies on.** The loop adversarially
  verifies consequential work with sub-agents (`doddy`, `testineer`, `rigorous-architect`, `wolf`,
  `proofreader`, `makeover`, `codd`, `cartographer`) and uses workflow skills (`executing-plans`,
  `writing-plans`, `agent-first-engineering`, `session-handoff`). These live in your Claude Code
  config, **not** in this repo. Provision them on the server one of two ways:
  - **Sync your `~/.claude`** to the server (the simplest — brings agents *and* skills, plus your
    auth). Most dotfile setups already do this.
  - **or bundle them into the repo** under `.claude/agents/` (project-scoped) if you'd rather the
    repo be fully self-contained — the loop will find them there. (Not done by default, to avoid
    publishing your personal agent prompts without your say-so.)

  The loop degrades gracefully if a *skill* is missing (CLAUDE.md describes the same workflows), but a
  missing *specialist agent* means that review is skipped — so make sure at least the agents are
  present for the loop's safety reviews to run.

### One-time setup
```bash
# 1. Clone and install
git clone git@github.com:scshafe/wedding-planner.git ~/wedding-planner
cd ~/wedding-planner
npm install

# 2. Verify it's green and the run script works (does a real build session — Ctrl-C to abort early)
npm run build && npm test && npm run lint
bash ops/run.sh            # first run; logs to ~/.wedding-planner-build/logs/

# 3a. Schedule with systemd (preferred on Linux). Copy the user units and enable the timer:
mkdir -p ~/.config/systemd/user
cp ops/systemd/wedding-planner-build.{service,timer} ~/.config/systemd/user/
#   (edit paths/Environment in the .service if you cloned elsewhere or claude isn't on PATH)
systemctl --user daemon-reload
systemctl --user enable --now wedding-planner-build.timer
loginctl enable-linger "$USER"     # so the timer runs without an active login session

#   ...or 3b. Schedule with cron instead (every 3 hours):
# crontab -e
# 0 */3 * * * /usr/bin/env bash $HOME/wedding-planner/ops/run.sh >> $HOME/.wedding-planner-build/cron.log 2>&1
```

### Configuration (optional env vars, see `ops/run.sh`)
`CLAUDE_BIN` (path to the CLI), `WP_MODEL` (default `opus`), `WP_EFFORT` (`low|medium|high|max`,
default `high`), `WP_STATE_DIR` (lock + logs location, default `~/.wedding-planner-build`).

### Operating it
```bash
# Watch the newest run live:
tail -f "$(ls -t ~/.wedding-planner-build/logs/build-*.log | head -1)"
# Trigger a run now:
systemctl --user start wedding-planner-build.service     # (or: bash ops/run.sh)
# Pause / resume the schedule:
systemctl --user disable --now wedding-planner-build.timer
systemctl --user enable  --now wedding-planner-build.timer
# See progress (the real heartbeat is commits):
git -C ~/wedding-planner log --oneline -15 main
```

## ⚠️ Run exactly ONE loop against this repo

Two schedulers (e.g. a laptop AND this server) both building and pushing will diverge `main` and
fight. Pick one runner. If you previously ran it locally, pause that one before enabling the server.
If `main` ever diverges from the build branch, the merge-keeper safely stops advancing `main` and
logs "manual reconciliation needed" until you reconcile by hand.
