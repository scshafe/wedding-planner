---
name: engineering-loop-v2
description: "The role-based engineering loop (2026-10-13): GitHub Issues as the system of record, six scheduled headless roles on cole-arch-pc, labels as the trust boundary on a public repo, a claude.ai artifact dashboard; why not OpenProject or a GitHub Project board"
metadata:
  type: project
---

**What it is (owner-directed, 2026-10-13).** The June loop (one prompt, every 3 h, a merge-keeper that
fast-forwarded and pushed `main`) is retired: since 2026-10-05 a push to `main` deploys through the
runner lane, so a direct push would skip PR review and deploy unreviewed. The replacement is six
headless roles run by root-owned systemd timers as `agent-wedding-planner` (`ops/loop/`, explained in
`ops/AUTONOMOUS_OPERATION.md`): builder (3 h), sre (hourly, precheck-gated), feedback, triage,
synthetic (daily), reporter (twice daily). Every change lands as a PR with CI green and a
`Merge #N: <title>` merge commit.

**Owner decisions (2026-10-13), with the alternatives they rejected:**
- *Auto-merge everything* (not "PRs touching rails wait for the owner", not "owner approves every
  merge"). The builder still may not edit `ops/` or the AGENTS.md rails: that rail is separate from
  merge autonomy, and loop changes go to the owner as `area:loop` + `status:needs-owner` issues.
- *Moderate cadence*, as above; per-role model/effort and a daily budget cap live in
  `~/.wedding-planner-loop/config.env`, not in the repo.
- *GitHub Issues + a claude.ai artifact dashboard*, not OpenProject. Why: the agents cannot reach
  the tailnet by design, and the broker mints only short-lived GitHub tokens. A self-hosted tracker
  would need a public endpoint and a long-lived API key, and two systems of record drift.
- A GitHub Project board can't be the dashboard either: GitHub Apps (the bot) cannot access
  Projects v2 owned by a personal account, so the bot could never move cards. Labels are the state.

**Load-bearing invariants:**
- **The repository is public, so labels are the trust boundary.** Only triage+ users can label,
  but issue FORMS apply their labels for anyone, so forms carry intake labels only (`status:triage`).
  `status:ready` counts only if a trusted actor applied it AND a trusted actor wrote the issue (an
  author can edit the body after labeling: a time-of-check/time-of-use hole). The builder precheck
  reads the event log (`actor.login`: `scshafe` or `scshafe-agent[bot]`) and the author (gh shows the
  bot as `app/scshafe-agent`); the builder reads comments only through a trusted-author filter, and
  resumes only `loop:pr` PRs the bot opened.
- **Untrusted text is rewritten before it gains authority:** the feedback role turns raw stranger
  text into bot-authored issues in its own words. Triage promotes only trusted-authored issues.
- **Every idle tick is free:** shell prechecks (`ops/loop/prechecks/`, exit 10 = nothing to do)
  gate the model call. The journal (`~/.wedding-planner-loop/journal.jsonl`) records skips as
  the heartbeat.
- **Runs execute merged code:** the outer stage refreshes the role's own clone to `origin/main` and
  execs that copy of the runner while holding the group lock (fd 9 survives the exec).
- **The dashboard escapes everything and links only https://github.com/ URLs** (issue titles are
  stranger-controlled). It is a pure render of a snapshot (`ops/loop/dashboard/`, tested).

**Hardening from the adversarial review (2026-10-13), each closing a concrete attack:**
- *Fork PR from a branch named `main`* reports `headBranch: main`, so health counts only `push` /
  `workflow_dispatch` runs (prechecks and dashboard). Otherwise a stranger could paint main red
  and send builder/SRE to read attacker-printed logs.
- *Bot laundering:* any role reading stranger text holds the same bot token, so it could write a
  bot-authored, bot-labeled issue. Mitigations: the triage precheck labels strangers' issues in
  shell (no model reads them); the feedback role is OFF by default with a tool allowlist; any issue
  that EVER carried `source:customer` (event log) needs the OWNER's `status:ready`.
- *Persistence:* `config.env` is parsed as whitelisted data, never sourced; trusted actors are
  hard-coded; `npm ci --ignore-scripts` runs every time with tokens unset (`node_modules` rebuilt).
- *Spend:* `--max-budget-usd` per session; killed runs journal their cap as cost; the SRE wakes
  once per failing run id (`state/sre-seen-runs`), not hourly; at most one auto-revert per 24 h,
  and only for verify failures.
- Residual: the model resisting injected text, and an agent-writable home. Owner-side controls
  (#16: ruleset requiring PR + verify, optional CODEOWNERS on rails) are what an agent can't undo.

**How to apply:** treat issue state as the plan. Don't recreate a merge-keeper or push `main`
directly. Keep issue forms free of authority labels. When adding a role, give it a precheck, a
lock group and a `LOOP-RESULT` outcome the dashboard knows. Related: [[autonomous-build-loop]]
(superseded), [[product-direction-full-planner-workspace]], [[agents-own-buildout-decisions]].
