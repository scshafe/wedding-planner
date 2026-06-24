---
name: autonomous-build-loop
description: A macOS system LaunchDaemon (user 'cole') runs autonomous build sessions every 3h via ops/run.sh — expect agent-authored commits on build/* branches and main getting pushed to origin between manual sessions
metadata: 
  node_type: memory
  type: project
  originSessionId: e797abb3-1adc-4d2b-9538-a31f279a8220
---

The user set up a **recurring autonomous build** (2026-06-24). A macOS **`launchd` system
LaunchDaemon**, `com.coleshaffer.wedding-planner-build`, runs `claude` headless **every 3 hours**
(`StartInterval 10800`, `RunAtLoad false`) with full autonomy: it reads `.claude/handoff.local.md`,
continues the in-progress plan or writes+builds the next phase itself, commits per verified step on a
`build/*` branch, updates the handoff, and stops.

**It runs the IN-REPO launcher `ops/run.sh`** (a human-reserved operational rail — the agent must not
modify it). The daemon itself lives OUTSIDE the repo so the agent can't modify its own trigger:
- **Loaded plist:** `/Library/LaunchDaemons/com.coleshaffer.wedding-planner-build.plist` (root:wheel,
  644). Source copy kept at `~/.wedding-planner-build/com.coleshaffer.wedding-planner-build.plist`.
- Runs as **`UserName cole`** — a system daemon, **not** a per-user LaunchAgent, so it runs even when
  no one is logged into a GUI session. (An earlier note described a `~/Library/LaunchAgents/` agent +
  an out-of-repo `~/.claude/automation/wedding-planner/build.sh`; that setup never existed on this
  machine — the real one is this LaunchDaemon driving the in-repo `ops/run.sh`.)
- A daemon gets a minimal environment, so the plist sets it explicitly: `HOME=/Users/cole`; a `PATH`
  that includes node/npm (`~/.openclaw/tools/node/bin`) and the `claude` binary; `CLAUDE_BIN=
  ~/.local/bin/claude`; `WP_MODEL=opus`; `WP_EFFORT=high`. **`run.sh`'s own hardcoded PATH does NOT
  include the openclaw node dir** — that's why PATH must be set in the plist, or `npm` (hence the
  merge-keeper's build/test/lint) would be missing.
- **Headless auth works because creds are file-based** (`~/.claude/.credentials.json`; no Keychain
  item). A LaunchDaemon can't reach the GUI login Keychain, so file-based creds + `HOME` set are what
  let unattended `claude` authenticate. **If auth ever moves to the Keychain, the daemon breaks** —
  verify with a `say OK` smoke test in a clean `env -i` (HOME + PATH only) before trusting it.
- **State + logs:** `~/.wedding-planner-build/` — single-flight `run.lock` (prevents overlap),
  `logs/build-*.log` (per-run claude output), and the daemon's own `launchd.out.log`/`launchd.err.log`.

**`main` is kept current automatically (the "merge-keeper" in `ops/run.sh`).** The agent only ever
commits to the `build/*` branch (never `main`); the wrapper, after each run, fast-forwards `main` to
the branch tip — but only if the tree is clean AND `npm run build && npm test && npm run lint` all
pass — then **pushes `main` + the branch to `origin`** (`git@github.com:scshafe/wedding-planner.git`).
So `main` only advances to a green, verified state and never drifts more than one run (~3h) behind. A
divergence (a hand commit on `main` the build branch lacks) makes the merge-keeper skip and log
"manual reconciliation needed" rather than risk losing work. **Don't hand-commit to `main` while a
build branch is mid-flight**, or you'll stall the auto-merge — it's only safe to commit to `main`
directly when there's no active build branch and `main == origin/main`.

**Implications for a manual session:**
- Expect **agent-authored commits on `build/*` branches** you didn't make, and `main` advancing +
  being pushed to `origin` between sessions; `git log --oneline` + `git branch` show them. Everything
  is per-step-committed and revertible.
- The **handoff is the shared continuation point** — both you and the loop read/update it.
- Operate it (system domain → needs `sudo`):
  - Pause: `sudo launchctl bootout system/com.coleshaffer.wedding-planner-build`
  - Resume: `sudo launchctl bootstrap system /Library/LaunchDaemons/com.coleshaffer.wedding-planner-build.plist`
  - Trigger now: `sudo launchctl kickstart -k system/com.coleshaffer.wedding-planner-build`
  - Status: `sudo launchctl print system/com.coleshaffer.wedding-planner-build`

**Runs only while the Mac is awake** (a local daemon). The repo is already pushed to a private GitHub
`origin`, so the remaining cloud upgrade is running the LOOP itself in the cloud (a scheduled routine
+ Max plan for an 8/day cadence; the kickoff prompt carries over unchanged) — see the cloud-vs-local
analysis from the original session if revisiting.
