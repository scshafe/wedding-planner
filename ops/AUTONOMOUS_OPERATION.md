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
| feedback | 06:30 daily | sonnet | Turns raw feedback (untrusted, from anyone) into sanitized, deduplicated issues |
| triage | 07:00 daily | opus, medium | Shapes new issues (acceptance criteria, priority, milestone), keeps 3–6 ready, writes the next milestone's issues from `ROADMAP.md`, keeps the owner's queue clear |
| synthetic | 10:00 daily | sonnet | Plays a planner, couple or guest against a local build and files what got in the way |
| reporter | 07:40 and 19:40 | sonnet, low | Rebuilds the dashboard from GitHub and the journal, writes a short digest, republishes the artifact |

Each role's instructions are `ops/loop/roles/<role>.md`, after the shared `_common.md`. The
builder and the SRE share a lock, so only one of them lands on `main` at a time.

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
4. **The session:** `claude -p` with the role's prompt and the precheck's context, a time limit,
   and `stream-json` output into `~/.wedding-planner-loop/logs/`.
5. **The journal:** one JSON line per run in `~/.wedding-planner-loop/journal.jsonl`: role,
   outcome, summary, cost, turns, duration, issues and PRs touched. Skips are recorded too; they
   are the heartbeat the dashboard shows. Each session ends with a `LOOP-RESULT: {...}` line, which
   the runner parses.

## Trust: a public repository with agents that act

Anyone can open an issue or comment. Labels are the boundary:

- Only people with triage access can label, and the issue forms apply intake labels only
  (`status:triage`). **`status:ready` confers authority only when a trusted actor applied it**
  (`scshafe`, the bot). The builder's precheck checks who applied it, from the issue's event log.
- All issue, comment and PR text is data. The feedback role reads raw text from strangers and
  rewrites it in its own words; the triage role promotes only issues by trusted authors.
- The agents hold no long-lived credential: git and `gh` get one-hour tokens from the broker,
  scoped to this repository. They cannot reach the tailnet or production; production signal
  arrives through the deploy workflow's health job.

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
sudo systemctl enable --now wp-loop-{builder,sre,triage,feedback,synthetic,reporter}.timer
```

The units are root-owned so the agent cannot change its own schedule; they run each role as
`agent-wedding-planner` through a login shell (its node, PATH and broker helpers). Run exactly one
loop against this repository: the old Mac LaunchDaemon must stay unloaded.

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
