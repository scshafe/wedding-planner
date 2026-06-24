---
name: autonomous-build-loop
description: A local launchd job runs autonomous build sessions every 3h — expect agent-authored commits on build/* branches between manual sessions
metadata: 
  node_type: memory
  type: project
  originSessionId: e797abb3-1adc-4d2b-9538-a31f279a8220
---

The user set up a **recurring autonomous build** (2026-06-24). A macOS `launchd` job,
`com.coleshaffer.wedding-planner-build`, runs `claude` headless **every ~3 hours** with full
autonomy: it reads `.claude/handoff.local.md`, continues the in-progress plan or writes+builds the
next phase itself, commits per verified step on a `build/*` branch, updates the handoff, and stops.

**Launcher lives OUTSIDE the repo** (so the agent can't modify its own trigger):
`~/.claude/automation/wedding-planner/` (`build.sh`, `kickoff-prompt.md`, `logs/`) +
`~/Library/LaunchAgents/com.coleshaffer.wedding-planner-build.plist`. Runs `--model opus
--effort high --verbose --dangerously-skip-permissions`; single-flight lockfile prevents overlap.

**`main` is kept current automatically (the "merge-keeper").** The agent only ever commits to the
`build/*` branch (never `main`); the WRAPPER, after each run, fast-forwards `main` to the branch tip
— but only if the tree is clean AND `npm run build && npm test && npm run lint` all pass. So `main`
only advances to a green, verified state and never drifts more than one run (~3h) behind. There is no
remote (local repo), so this is the local equivalent of merging a green PR. A divergence (e.g. a hand
commit on `main`) makes the merge-keeper skip and log "manual reconciliation needed" rather than risk
losing work. Don't hand-commit to `main` while the loop runs, or you'll stall the auto-merge.

**Implications for a manual session:**
- Expect **agent-authored commits on `build/*` branches** you didn't make; `git log --oneline` +
  `git branch` show them. Everything is per-step-committed and revertible.
- The **handoff is the shared continuation point** — both you and the loop read/update it.
- If you need exclusive access (avoid a concurrent autonomous run clobbering your work), **pause it**:
  `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.coleshaffer.wedding-planner-build.plist`
  (resume with `bootstrap`). Or trigger one on demand with `launchctl kickstart -k
  gui/$(id -u)/com.coleshaffer.wedding-planner-build`.

**Local-only for now** (no GitHub remote — the user declined the push; runs only while the Mac is
awake). The future upgrade is a **cloud routine** (push a private repo + Max plan for the 8/day
cadence; the kickoff prompt carries over unchanged) — see the cloud-vs-local analysis from this
session if revisiting.
