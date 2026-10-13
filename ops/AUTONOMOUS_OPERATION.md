# Autonomous operation: the engineering loop

This repository is built, debugged and operated by a team of headless Claude Code roles that run
on a schedule on cole-arch-pc as the project's agent user, `agent-wedding-planner`. GitHub Issues
are the system of record and a claude.ai artifact is the dashboard. The files in `ops/` are the
owner's operational rails: the agents do not change them to widen their own autonomy (AGENTS.md).

This replaces the June 2026 loop (`ops/run.sh` on a Mac LaunchDaemon), which fast-forwarded and
pushed `main` directly. Since merging to `main` deploys to production, every change now lands
through a PR with CI green.

## The roles

| Role | When | Model | What it does |
|---|---|---|---|
| builder | every 3 h at :15 | opus, high | Takes the best `status:ready` issue, builds it on a `build/*` branch with tests and review agents, opens a PR (`Closes #N`), waits for CI, merges `Merge #N: <title>`, watches the deploy, reverts on failure |
| sre | hourly at :45 | sonnet | Only when main's CI or the latest deploy is red, or an incident is open: reverts a broken merge, files incidents, asks the owner for host problems |
| feedback | 06:30 daily, **off until you enable it** | sonnet, limited tools | Turns raw feedback (untrusted, from anyone) into sanitized, deduplicated issues that only you can promote |
| triage | 07:00 daily | opus, medium, limited tools | Shapes new issues (acceptance criteria, priority, milestone), keeps 3–6 ready, writes the next milestone's issues from `ROADMAP.md`, keeps the owner's queue clear |
| synthetic | 10:00 daily | sonnet | Plays a planner, couple or guest against a local build and files what got in the way |
| reporter | 07:40 and 19:40 | sonnet, low, limited tools | Rebuilds the dashboard from GitHub and the journal, writes a short digest, republishes the artifact |

Each role's instructions are `ops/loop/roles/<role>.md`, after the shared `_common.md`. The
builder and the SRE share a lock, so only one of them lands on `main` at a time. Every session has
a spend cap (`--max-budget-usd`: builder $40, triage and SRE and synthetic $8, feedback $4,
reporter $3; `WP_LOOP_MAX_USD_<ROLE>` overrides). Roles that read text strangers can influence
and don't change code (triage, feedback, reporter) run with a tool allowlist instead of every tool.

## How one run works (`ops/loop/run-role.sh <role>`)

1. **Lock** the role's group (`flock`); a run still going means this tick is skipped.
2. **Refresh the role's own clone** (`~/.wedding-planner-loop/work/<role>`) to `origin/main`, and
   run *that* clone's copy of the runner. What runs is always merged code, never a branch someone
   has checked out in the interactive clone.
3. **Gates**, all failing closed:
   - *pause:* any open issue labeled `loop:paused` stops every role;
   - *budget:* when `WP_LOOP_DAILY_BUDGET_USD` is set, every role but the SRE stops once the
     day's recorded spend reaches it;
   - *precheck:* `ops/loop/prechecks/<role>.sh` gathers context from GitHub with no model call
     and exits 10 when there is nothing to do, so an idle tick costs nothing.
4. **The session:** a clean `npm ci --ignore-scripts` with no credential in its environment,
   then `claude -p` with the role's prompt and the precheck's context, a time limit, a spend cap,
   and `stream-json` output into `~/.wedding-planner-loop/logs/`.
5. **The journal:** one JSON line per run in `~/.wedding-planner-loop/journal.jsonl`: role,
   outcome, summary, cost, turns, duration, issues and PRs touched. Skips are recorded too; they
   are the heartbeat the dashboard shows. Each session ends with a `LOOP-RESULT: {...}` line, which
   the runner parses.

## Trust: a public repository with agents that act

Anyone can open an issue, comment or pull request. What stops a stranger from steering an agent
that merges to production:

- **Labels confer authority, and strangers can't apply them.** The issue forms apply intake labels
  only (`status:triage`). The builder works an issue only when a trusted actor (`scshafe`, the bot)
  wrote it **and** applied `status:ready` (an author can edit the body after it was labeled). If
  the issue ever carried `source:customer` (work derived from a stranger's feedback), only the
  owner's `status:ready` counts. The builder reads only trusted comments and resumes only the
  bot's own `loop:pr` PRs. The trusted list is hard-coded in `ops/loop/lib.sh`.
- **Stranger text reaches one role only.** The triage precheck labels strangers' issues
  `type:feedback` in the shell, without a model reading them. The feedback role is the only one
  that reads them, with a tool allowlist, and it is **off by default** (its timer is not enabled
  below). Turn it on once there are real people filing feedback.
- **"Main is red" means main.** Health counts only runs that `main` triggered (push or dispatch),
  so a fork PR from a branch named `main` cannot send the builder or SRE to read its logs.
- **No credential reaches installed code.** Dependencies install with `--ignore-scripts` and
  without the agent's tokens in the environment; `node_modules` is rebuilt every run.
- **The agents hold no long-lived credential.** git and `gh` get one-hour tokens from the broker,
  scoped to this repository. The agents cannot reach the tailnet or production; production signal
  arrives through the deploy workflow's health job.

What remains is the model resisting injected text. Two cheap owner-side controls close most of
it (issue #16):
- a ruleset on `main` requiring a pull request and the `verify` check, so nothing reaches
  production by a direct push;
- optionally, CODEOWNERS on `ops/`, `.github/`, `deploy/`, `AGENTS.md`, `Dockerfile` and the npm
  manifests, so the loop cannot change its own gates or the deploy path without you.

## The dashboard

`ops/loop/dashboard/build_dashboard.ts` collects issues, PRs, Actions runs, milestones and the
journal, and writes `data.json` and a self-contained `index.html` under
`~/.wedding-planner-loop/dashboard/`. The reporter publishes it to the claude.ai artifact named
by `WP_DASHBOARD_URL` in `~/.wedding-planner-loop/config.env`. It shows what is waiting on you,
incidents, work in progress, the ready queue, what shipped this week, CI and deploy health,
milestone progress, the run of show (recent runs), role heartbeats, spend and the feedback inbox.

To preview it locally: `npx tsx ops/loop/dashboard/build_dashboard.ts --out /tmp/wp-dash`.

## Install (the owner, once)

```sh
cd ~/src/wedding-planner && git pull --ff-only
sudo install -m 0644 -t /etc/systemd/system ops/loop/systemd/wp-loop@.service ops/loop/systemd/wp-loop-*.timer
sudo systemctl daemon-reload
sudo systemctl start wp-loop@reporter.service          # smoke test: one run, then read the journal
sudo -u agent-wedding-planner tail -n 1 /home/agent-wedding-planner/.wedding-planner-loop/journal.jsonl
sudo systemctl enable --now wp-loop-{builder,sre,triage,synthetic,reporter}.timer
# Later, when real people file feedback: sudo systemctl enable --now wp-loop-feedback.timer
```

The units are root-owned so the agent cannot change its own schedule; they run each role as
`agent-wedding-planner` through a login shell (its node, PATH and broker helpers). Run exactly one
loop against this repository: the old Mac LaunchDaemon must stay unloaded. The agent user owns its
home, so anything the units run there (the profile, the clones) is agent-writable; the owner-side
controls above are what an agent cannot undo.

## Operate

| To | Do |
|---|---|
| Pause every role | Open any issue with the label `loop:paused` (close it to resume), or `sudo systemctl stop 'wp-loop-*.timer'` |
| Run a role now | `sudo systemctl start wp-loop@<role>.service` |
| See the schedule | `systemctl list-timers 'wp-loop-*'` |
| Read a run | `journalctl -u wp-loop@<role>.service`, then the log named in its journal line |
| Cap spend | `WP_LOOP_DAILY_BUDGET_USD=<usd>` in `~/.wedding-planner-loop/config.env` |
| Change a model or effort | `WP_LOOP_MODEL_<ROLE>` / `WP_LOOP_EFFORT_<ROLE>` in the same file |
| Roll production back | Merge a `git revert`, or `gh workflow run deploy.yml -f sha=<older sha> -f allow_rollback=true` |

`config.env` holds settings only, never secrets (`ops/loop/config.env.example`).
