#!/usr/bin/env bash
# Autonomous build run for the wedding-planner repo. Portable (Linux/macOS); invoked by a scheduler
# (systemd timer or cron) every few hours. See ops/AUTONOMOUS_OPERATION.md.
#
# What it does, in one run:
#   1. single-flight lock (skip if a run is already active; self-heal a hung lock)
#   2. run `claude` headless from the repo with ops/kickoff-prompt.md (it continues/plans the build)
#   3. merge-keeper: fast-forward main to the build-branch tip IFF clean AND build+test+lint pass
#   4. push main + the build branch to origin
#
# Configure via env (all optional):
#   CLAUDE_BIN   path to the claude CLI            (default: `claude` on PATH)
#   WP_MODEL     model                              (default: opus)
#   WP_EFFORT    reasoning effort low|medium|high|max (default: high)
#   WP_STATE_DIR where lock + logs live, OUTSIDE the repo (default: $HOME/.wedding-planner-build)
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"
MODEL="${WP_MODEL:-opus}"
EFFORT="${WP_EFFORT:-high}"
PROMPT_FILE="$SCRIPT_DIR/kickoff-prompt.md"
STATE_DIR="${WP_STATE_DIR:-$HOME/.wedding-planner-build}"
LOCK="$STATE_DIR/run.lock"
LOGDIR="$STATE_DIR/logs"
STALE_LOCK_MINUTES="${WP_STALE_LOCK_MINUTES:-150}"

# Ensure node + common bins are reachable when launched from a minimal scheduler environment.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$PATH"

mkdir -p "$LOGDIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOGDIR/build-$STAMP.log"

# --- single-flight with stale-lock self-heal ----------------------------------------------------
if [ -d "$LOCK" ] && find "$LOCK" -maxdepth 0 -mmin +"$STALE_LOCK_MINUTES" 2>/dev/null | grep -q .; then
  echo "[$STAMP] reclaiming stale lock (>${STALE_LOCK_MINUTES}m)" >> "$LOGDIR/skips.log"
  rmdir "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[$STAMP] a run is already active; skipping this tick" >> "$LOGDIR/skips.log"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

cd "$REPO" || { echo "[$STAMP] repo not found: $REPO" >> "$LOG"; exit 1; }

{
  echo "=== wedding-planner autonomous build @ $STAMP ==="
  echo "claude:  $("$CLAUDE" --version 2>/dev/null)"
  echo "model:   $MODEL   effort: $EFFORT"
  echo "branch:  $(git branch --show-current 2>/dev/null)   head: $(git rev-parse --short HEAD 2>/dev/null)"
  echo "------------------------------------------------------------"
} >> "$LOG"

# --- the build session --------------------------------------------------------------------------
# --verbose streams turn-by-turn progress to the log; < /dev/null since a scheduler has no stdin.
"$CLAUDE" \
  --dangerously-skip-permissions \
  --model "$MODEL" \
  --effort "$EFFORT" \
  --verbose \
  -p "$(cat "$PROMPT_FILE")" \
  < /dev/null \
  >> "$LOG" 2>&1
CODE=$?

{
  echo "------------------------------------------------------------"
  echo "=== run finished @ $(date +%Y%m%d-%H%M%S), exit=$CODE ==="
} >> "$LOG"

# --- merge-keeper: keep main current with verified work, then push -------------------------------
# main only ever advances to a green, verified state, and never drifts more than one run behind.
BRANCH="$(git branch --show-current 2>/dev/null)"
{
  echo "--- merge-keeper ---"
  if [ "${BRANCH#build/}" = "$BRANCH" ]; then
    echo "[merge-keeper] not on a build/* branch ($BRANCH); main NOT advanced"
  elif [ -n "$(git status --porcelain)" ]; then
    echo "[merge-keeper] working tree not clean; main NOT advanced"
  elif ! git merge-base --is-ancestor main "$BRANCH" 2>/dev/null; then
    echo "[merge-keeper] main has diverged from $BRANCH; manual reconciliation needed"
  elif npm run build >/dev/null 2>&1 && npm test >/dev/null 2>&1 && npm run lint >/dev/null 2>&1; then
    BEFORE="$(git rev-parse --short main)"
    git branch -f main "$BRANCH"
    echo "[merge-keeper] main $BEFORE -> $(git rev-parse --short main) (fast-forwarded to $BRANCH, green)"
    if git push origin main "$BRANCH" >> "$LOG" 2>&1; then
      echo "[merge-keeper] pushed main + $BRANCH to origin"
    else
      echo "[merge-keeper] PUSH FAILED — check SSH auth / network; work is safe locally"
    fi
  else
    echo "[merge-keeper] branch is NOT green (build/test/lint failed); main NOT advanced"
  fi
} >> "$LOG" 2>&1

# Keep only the most recent 50 run logs.
ls -1t "$LOGDIR"/build-*.log 2>/dev/null | tail -n +51 | xargs rm -f 2>/dev/null

exit $CODE
