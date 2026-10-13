#!/usr/bin/env bash
# The engineering loop's runner: run ONE role, headless, once. A root-owned systemd timer
# (ops/loop/systemd/) starts it as agent-wedding-planner. See ops/AUTONOMOUS_OPERATION.md.
#
#   run-role.sh <role>           outer stage: take the role group's lock, refresh the role's own
#                                clone to origin/main, then exec THAT clone's copy of this script,
#                                so what runs is always merged code (never a branch someone has
#                                checked out in the interactive clone)
#   run-role.sh <role> --inner   inner stage: pause, budget and precheck gates, the claude
#                                session, one journal record
#
# Roles: builder sre triage feedback synthetic reporter (prompts in ops/loop/roles/).
#
# Config: the environment, or $WP_LOOP_HOME/config.env (see ops/loop/config.env.example).
set -uo pipefail

ROLE="${1:-}"
STAGE="${2:-outer}"
REPO_SLUG="scshafe/wedding-planner"
ORIGIN_URL="https://github.com/$REPO_SLUG"
LOOP_HOME="${WP_LOOP_HOME:-$HOME/.wedding-planner-loop}"
if [ -f "$LOOP_HOME/config.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$LOOP_HOME/config.env"
  set +a
fi
CLAUDE="${CLAUDE_BIN:-claude}"
TRUSTED="${WP_LOOP_TRUSTED_ACTORS:-scshafe scshafe-agent[bot] app/scshafe-agent}"
JOURNAL="$LOOP_HOME/journal.jsonl"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# --- the role table: model, effort, time limit, lock group -------------------------------------
# builder and sre share the "land" group: only one of them may be merging to main at a time.
case "$ROLE" in
  builder)   MODEL=opus;   EFFORT=high;   TIMEOUT_MIN=150; GROUP=land ;;
  sre)       MODEL=sonnet; EFFORT=medium; TIMEOUT_MIN=45;  GROUP=land ;;
  triage)    MODEL=opus;   EFFORT=medium; TIMEOUT_MIN=60;  GROUP=triage ;;
  feedback)  MODEL=sonnet; EFFORT=medium; TIMEOUT_MIN=45;  GROUP=feedback ;;
  synthetic) MODEL=sonnet; EFFORT=medium; TIMEOUT_MIN=75;  GROUP=synthetic ;;
  reporter)  MODEL=sonnet; EFFORT=low;    TIMEOUT_MIN=30;  GROUP=reporter ;;
  *) echo "usage: run-role.sh <builder|sre|triage|feedback|synthetic|reporter>" >&2; exit 2 ;;
esac
ROLE_UPPER="$(printf '%s' "$ROLE" | tr '[:lower:]' '[:upper:]')"
model_var="WP_LOOP_MODEL_$ROLE_UPPER"; MODEL="${!model_var:-$MODEL}"
effort_var="WP_LOOP_EFFORT_$ROLE_UPPER"; EFFORT="${!effort_var:-$EFFORT}"

mkdir -p "$LOOP_HOME/work" "$LOOP_HOME/logs" "$LOOP_HOME/locks"
WORK="$LOOP_HOME/work/$ROLE"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="${WP_LOOP_RUN_ID:-$ROLE-$(date -u +%Y%m%dT%H%M%SZ)}"
export WP_LOOP_RUN_ID="$RUN_ID"

# One JSON line per run (skips included: they are the loop's heartbeat). The dashboard reads it.
journal() { # outcome summary [extra-json-object]
  local extra="${3:-}"
  [ -n "$extra" ] || extra='{}'
  jq -cn --arg run "$RUN_ID" --arg role "$ROLE" --arg started "$STARTED" \
    --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg outcome "$1" --arg summary "$2" \
    --argjson extra "$extra" \
    '{run_id:$run, role:$role, started_at:$started, finished_at:$finished, outcome:$outcome, summary:$summary} + $extra' \
    >> "$JOURNAL"
}
skip() { # reason summary
  journal skipped "$2" "$(jq -cn --arg r "$1" '{skip_reason:$r}')"
  exit 0
}

# --- single flight per lock group (the lock is held across the exec into the inner stage) -------
LOCK="$LOOP_HOME/locks/$GROUP.lock"
if ! { true >&9; } 2>/dev/null; then exec 9>"$LOCK"; fi
flock -n 9 || skip locked "Another $GROUP-group run is still going."

# --- outer stage: refresh the role's clone, run its copy of this script -------------------------
if [ "$STAGE" != "--inner" ]; then
  if [ ! -d "$WORK/.git" ]; then
    git clone --quiet "$ORIGIN_URL" "$WORK" || skip clone-failed "Could not clone $ORIGIN_URL."
  fi
  git -C "$WORK" fetch --quiet --prune origin || skip fetch-failed "git fetch failed (network or broker)."
  git -C "$WORK" checkout --quiet --force --detach origin/main || skip checkout-failed "Could not check out origin/main."
  git -C "$WORK" reset --quiet --hard origin/main
  git -C "$WORK" clean -ffdxq -e node_modules
  exec "$WORK/ops/loop/run-role.sh" "$ROLE" --inner
fi

cd "$WORK" || skip no-clone "The role clone $WORK is missing."
LOG="$LOOP_HOME/logs/$RUN_ID.jsonl"
ERRLOG="$LOOP_HOME/logs/$RUN_ID.err"

# --- gates: owner pause, daily budget, the role's precheck ---------------------------------------
# A GitHub failure closes the gate: no run without a working broker.
PAUSED="$(gh issue list -R "$REPO_SLUG" --label loop:paused --state open --json number --jq length 2>>"$ERRLOG")" \
  || skip github-unavailable "GitHub did not answer the pause check (broker or network)."
[ "${PAUSED:-0}" = "0" ] || skip paused "An open issue labeled loop:paused pauses the loop."

if [ -n "${WP_LOOP_DAILY_BUDGET_USD:-}" ] && [ "$ROLE" != "sre" ] && [ -f "$JOURNAL" ]; then
  SPENT="$(jq -rs --arg d "$(date -u +%Y-%m-%d)" \
    '[.[] | select(.started_at | startswith($d)) | (.cost_usd // 0)] | add // 0' "$JOURNAL" 2>/dev/null || echo 0)"
  if awk -v s="$SPENT" -v b="$WP_LOOP_DAILY_BUDGET_USD" 'BEGIN { exit !(s >= b) }'; then
    skip budget "Today's recorded spend (\$$SPENT) reached WP_LOOP_DAILY_BUDGET_USD (\$$WP_LOOP_DAILY_BUDGET_USD)."
  fi
fi

CONTEXT=""
PRECHECK="$WORK/ops/loop/prechecks/$ROLE.sh"
if [ -f "$PRECHECK" ]; then
  CONTEXT="$(REPO_SLUG="$REPO_SLUG" WP_LOOP_TRUSTED_ACTORS="$TRUSTED" WP_LOOP_HOME="$LOOP_HOME" bash "$PRECHECK" 2>>"$ERRLOG")"
  rc=$?
  case "$rc" in
    0) ;;
    10) skip no-work "Precheck found nothing for the $ROLE to do." ;;
    11) skip not-configured "${CONTEXT:-The $ROLE is not configured.}" ;;
    *) skip precheck-failed "The $ROLE precheck failed (exit $rc); see $ERRLOG." ;;
  esac
fi

# --- dependencies: npm ci only when the lockfile changed ----------------------------------------
LOCK_HASH="$(sha256sum package-lock.json | cut -c1-64)"
if [ "$(cat node_modules/.wp-loop-lock-hash 2>/dev/null)" != "$LOCK_HASH" ]; then
  npm ci --no-audit --no-fund >>"$ERRLOG" 2>&1 || skip npm-ci-failed "npm ci failed; see $ERRLOG."
  echo "$LOCK_HASH" > node_modules/.wp-loop-lock-hash
fi

# --- the session -------------------------------------------------------------------------------
PROMPT="$(cat ops/loop/roles/_common.md ops/loop/roles/"$ROLE".md)

## Run context (gathered by the runner before this session started)

- run id: $RUN_ID
- started: $STARTED (UTC)
- role: $ROLE; model: $MODEL; effort: $EFFORT; time limit: $TIMEOUT_MIN minutes
- your clone: $WORK (detached at origin/main $(git rev-parse --short HEAD))
- loop home: $LOOP_HOME (journal, logs, dashboard)
- trusted actors: $TRUSTED

$CONTEXT"

env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
  WP_LOOP_HOME="$LOOP_HOME" WP_LOOP_RUN_ID="$RUN_ID" WP_LOOP_TRUSTED_ACTORS="$TRUSTED" \
  timeout --kill-after=2m "${TIMEOUT_MIN}m" \
  "$CLAUDE" -p "$PROMPT" --model "$MODEL" --effort "$EFFORT" --dangerously-skip-permissions \
  --output-format stream-json --verbose < /dev/null > "$LOG" 2>>"$ERRLOG"
CODE=$?

# --- the journal record ------------------------------------------------------------------------
RESULT="$(jq -cR 'fromjson? | select(type == "object" and .type == "result")' "$LOG" 2>/dev/null | tail -n 1)"
[ -n "$RESULT" ] || RESULT='{}'
REPORT="$(jq -r '.result // ""' <<<"$RESULT" | grep -o 'LOOP-RESULT: {.*}' | tail -n 1 | sed 's/^LOOP-RESULT: //')"
if ! jq -e 'type == "object" and (.outcome | type == "string")' >/dev/null 2>&1 <<<"$REPORT"; then
  if [ "$CODE" = "124" ]; then
    REPORT="{\"outcome\":\"timeout\",\"summary\":\"Stopped at the $TIMEOUT_MIN-minute limit.\"}"
  else
    REPORT="{\"outcome\":\"unreported\",\"summary\":\"The session ended (exit $CODE) without a LOOP-RESULT line.\"}"
  fi
fi
EXTRA="$(jq -cn --argjson r "$RESULT" --argjson rep "$REPORT" --arg model "$MODEL" --arg effort "$EFFORT" \
  --argjson code "$CODE" --arg log "$LOG" \
  '{model:$model, effort:$effort, exit_code:$code, log:$log,
    cost_usd:($r.total_cost_usd // null), num_turns:($r.num_turns // null),
    duration_s:(if $r.duration_ms then ($r.duration_ms / 1000 | floor) else null end),
    session_id:($r.session_id // null),
    issues:(($rep.issues // []) | map(select(type == "number"))),
    prs:(($rep.prs // []) | map(select(type == "number")))}')"
journal "$(jq -r '.outcome' <<<"$REPORT")" "$(jq -r '.summary // ""' <<<"$REPORT")" "$EXTRA"

# Keep the newest 40 logs per role.
ls -1t "$LOOP_HOME/logs/$ROLE"-*.jsonl 2>/dev/null | tail -n +41 | while read -r old; do
  rm -f "$old" "${old%.jsonl}.err"
done
exit "$CODE"
