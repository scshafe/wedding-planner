#!/usr/bin/env bash
# The engineering loop's runner: run ONE role, headless, once. A root-owned systemd timer
# (ops/loop/systemd/) starts it as agent-wedding-planner. See ops/AUTONOMOUS_OPERATION.md.
#
#   run-role.sh <role>           outer stage: take the role group's lock, refresh the role's own
#                                clone to origin/main, then exec THAT clone's copy of this script,
#                                so what runs is always merged code
#   run-role.sh <role> --inner   inner stage: pause, budget and precheck gates, the claude
#                                session, one journal record
#
# Roles: builder sre triage feedback synthetic reporter (prompts in ops/loop/roles/).
# Settings: $WP_LOOP_HOME/config.env, read as data (whitelisted keys), never sourced.
#
# The whole script is one function, parsed before it runs: the outer stage rewrites the clone the
# script may itself live in.
set -uo pipefail

main() {
ROLE="${1:-}"
STAGE="${2:-outer}"
REPO_SLUG="scshafe/wedding-planner"
ORIGIN_URL="https://github.com/$REPO_SLUG"
LOOP_HOME="${WP_LOOP_HOME:-$HOME/.wedding-planner-loop}"
CLAUDE="${CLAUDE_BIN:-claude}"
JOURNAL="$LOOP_HOME/journal.jsonl"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# --- settings: whitelisted keys with validated values; anything else in the file is ignored -----
load_config() {
  local file="$LOOP_HOME/config.env" key value
  [ -f "$file" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      WP_DASHBOARD_URL)
        [[ "$value" =~ ^https://claude\.ai/artifact/[A-Za-z0-9_-]+$ ]] && export "$key=$value" ;;
      WP_LOOP_DAILY_BUDGET_USD|WP_LOOP_MAX_USD_[A-Z]*)
        [[ "$value" =~ ^[0-9]+(\.[0-9]+)?$ ]] && export "$key=$value" ;;
      WP_LOOP_MODEL_[A-Z]*)
        [[ "$value" =~ ^(opus|sonnet|haiku|claude-[a-z0-9.-]+)$ ]] && export "$key=$value" ;;
      WP_LOOP_EFFORT_[A-Z]*)
        [[ "$value" =~ ^(low|medium|high|xhigh|max)$ ]] && export "$key=$value" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "$file")
}
load_config

# --- the role table -----------------------------------------------------------------------------
# model, effort, time limit, per-session spend cap (USD), lock group, and tools. builder and sre
# share the "land" group: only one of them may be merging to main at a time. Roles that read text
# strangers can influence, and do not need to change code, get an allowlist instead of every tool.
ISSUE_TOOLS=(Read Grep Glob "Bash(gh issue:*)" "Bash(gh search:*)")
TOOLS=()   # empty = every tool (--dangerously-skip-permissions); else an allowlist
case "$ROLE" in
  builder)   MODEL=opus;   EFFORT=high;   TIMEOUT_MIN=150; MAX_USD=40; GROUP=land ;;
  sre)       MODEL=sonnet; EFFORT=medium; TIMEOUT_MIN=45;  MAX_USD=8;  GROUP=land ;;
  triage)    MODEL=opus;   EFFORT=medium; TIMEOUT_MIN=60;  MAX_USD=8;  GROUP=triage
             TOOLS=("${ISSUE_TOOLS[@]}" "Bash(gh api repos/$REPO_SLUG/milestones:*)") ;;
  feedback)  MODEL=sonnet; EFFORT=medium; TIMEOUT_MIN=45;  MAX_USD=4;  GROUP=feedback
             TOOLS=("${ISSUE_TOOLS[@]}") ;;
  synthetic) MODEL=sonnet; EFFORT=medium; TIMEOUT_MIN=75;  MAX_USD=8;  GROUP=synthetic ;;
  reporter)  MODEL=sonnet; EFFORT=low;    TIMEOUT_MIN=30;  MAX_USD=3;  GROUP=reporter
             TOOLS=(Read Write ToolSearch Artifact PushNotification "Bash(npx tsx ops/loop/dashboard/build_dashboard.ts:*)") ;;
  *) echo "usage: run-role.sh <builder|sre|triage|feedback|synthetic|reporter>" >&2; exit 2 ;;
esac
ROLE_UPPER="$(printf '%s' "$ROLE" | tr '[:lower:]' '[:upper:]')"
v="WP_LOOP_MODEL_$ROLE_UPPER";   MODEL="${!v:-$MODEL}"
v="WP_LOOP_EFFORT_$ROLE_UPPER";  EFFORT="${!v:-$EFFORT}"
v="WP_LOOP_MAX_USD_$ROLE_UPPER"; MAX_USD="${!v:-$MAX_USD}"

mkdir -p "$LOOP_HOME/work" "$LOOP_HOME/logs" "$LOOP_HOME/locks" "$LOOP_HOME/state"
WORK="$LOOP_HOME/work/$ROLE"
STARTED="${WP_LOOP_STARTED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
RUN_ID="${WP_LOOP_RUN_ID:-$ROLE-$(date -u +%Y%m%dT%H%M%SZ)}"
export WP_LOOP_RUN_ID="$RUN_ID" WP_LOOP_STARTED="$STARTED"

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
# Children never inherit fd 9 (every command below closes it), so a stray background process
# cannot keep the group locked after the run.
LOCK="$LOOP_HOME/locks/$GROUP.lock"
if ! { true >&9; } 2>/dev/null; then exec 9>"$LOCK"; fi
flock -n 9 || skip locked "Another $GROUP-group run is still going."

# --- outer stage: refresh the role's clone, run its copy of this script -------------------------
if [ "$STAGE" != "--inner" ]; then
  if [ ! -d "$WORK/.git" ]; then
    git clone --quiet "$ORIGIN_URL" "$WORK" 9>&- || skip clone-failed "Could not clone $ORIGIN_URL."
  fi
  git -C "$WORK" fetch --quiet --prune origin 9>&- || skip fetch-failed "git fetch failed (network or broker)."
  git -C "$WORK" checkout --quiet --force --detach origin/main 9>&- || skip checkout-failed "Could not check out origin/main."
  git -C "$WORK" reset --quiet --hard origin/main 9>&-
  git -C "$WORK" clean -ffdxq 9>&-
  exec "$WORK/ops/loop/run-role.sh" "$ROLE" --inner
fi

cd "$WORK" || skip no-clone "The role clone $WORK is missing."
LOG="$LOOP_HOME/logs/$RUN_ID.jsonl"
ERRLOG="$LOOP_HOME/logs/$RUN_ID.err"

# --- gates: owner pause, daily budget, the role's precheck (all fail closed) ---------------------
PAUSED="$(gh issue list -R "$REPO_SLUG" --label loop:paused --state open --json number --jq length 2>>"$ERRLOG" 9>&-)" \
  || skip github-unavailable "GitHub did not answer the pause check (broker or network)."
[ "${PAUSED:-0}" = "0" ] || skip paused "An open issue labeled loop:paused pauses the loop."

if [ -n "${WP_LOOP_DAILY_BUDGET_USD:-}" ] && [ "$ROLE" != "sre" ] && [ -f "$JOURNAL" ]; then
  SPENT="$(jq -Rn --arg d "$(date -u +%Y-%m-%d)" \
    '[inputs | fromjson? | select(type == "object" and ((.started_at // "") | startswith($d))) | (.cost_usd // 0)] | add // 0' \
    "$JOURNAL" 2>>"$ERRLOG")" || skip budget-unreadable "Could not read today's spend from the journal."
  if awk -v s="$SPENT" -v b="$WP_LOOP_DAILY_BUDGET_USD" 'BEGIN { exit !(s >= b) }'; then
    skip budget "Today's recorded spend (\$$SPENT) reached WP_LOOP_DAILY_BUDGET_USD (\$$WP_LOOP_DAILY_BUDGET_USD)."
  fi
fi

CONTEXT=""
PRECHECK="$WORK/ops/loop/prechecks/$ROLE.sh"
if [ -f "$PRECHECK" ]; then
  CONTEXT="$(REPO_SLUG="$REPO_SLUG" WP_LOOP_HOME="$LOOP_HOME" timeout 10m bash "$PRECHECK" 2>>"$ERRLOG" 9>&-)"
  rc=$?
  case "$rc" in
    0) ;;
    10) skip no-work "Precheck found nothing for the $ROLE to do." ;;
    11) skip not-configured "${CONTEXT:-The $ROLE is not configured.}" ;;
    *) skip precheck-failed "The $ROLE precheck failed (exit $rc); see $ERRLOG." ;;
  esac
fi

# --- dependencies: a clean install every run, with no install scripts and no credentials in reach
# (git clean above removed node_modules, so nothing an earlier session planted there survives).
env -u CLAUDE_CODE_OAUTH_TOKEN -u NODE_AUTH_TOKEN -u GH_TOKEN \
  timeout 15m npm ci --ignore-scripts --no-audit --no-fund >>"$ERRLOG" 2>&1 9>&- \
  || skip npm-ci-failed "npm ci failed; see $ERRLOG."

# --- the session -------------------------------------------------------------------------------
PROMPT="$(cat ops/loop/roles/_common.md ops/loop/roles/"$ROLE".md)

## Run context (gathered by the runner before this session started)

- run id: $RUN_ID
- started: $STARTED (UTC)
- role: $ROLE; model: $MODEL; effort: $EFFORT; time limit: $TIMEOUT_MIN minutes; spend cap: \$$MAX_USD
- your clone: $WORK (detached at origin/main $(git rev-parse --short HEAD))
- loop home: $LOOP_HOME (journal, logs, dashboard)
- tools: $([ "${#TOOLS[@]}" -eq 0 ] && echo "all" || echo "limited to: ${TOOLS[*]}")
$([ "$ROLE" = reporter ] && echo "- dashboard artifact: ${WP_DASHBOARD_URL:-not configured}")

$CONTEXT"

if [ "${#TOOLS[@]}" -eq 0 ]; then
  PERMISSIONS=(--dangerously-skip-permissions)
else
  PERMISSIONS=(--allowedTools "${TOOLS[@]}")
fi
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
  WP_LOOP_HOME="$LOOP_HOME" WP_LOOP_RUN_ID="$RUN_ID" \
  timeout --kill-after=2m "${TIMEOUT_MIN}m" \
  "$CLAUDE" -p "$PROMPT" --model "$MODEL" --effort "$EFFORT" --max-budget-usd "$MAX_USD" \
  "${PERMISSIONS[@]}" --output-format stream-json --verbose < /dev/null > "$LOG" 2>>"$ERRLOG" 9>&-
CODE=$?

# --- the journal record ------------------------------------------------------------------------
RESULT="$(jq -cR 'fromjson? | select(type == "object" and .type == "result")' "$LOG" 2>/dev/null | tail -n 1)"
[ -n "$RESULT" ] || RESULT='{}'
REPORT="$(jq -r '.result // "" | strings' <<<"$RESULT" | grep -o 'LOOP-RESULT: {.*}' | tail -n 1 | sed 's/^LOOP-RESULT: //')"
if ! jq -e 'type == "object" and (.outcome | type == "string")' >/dev/null 2>&1 <<<"$REPORT"; then
  if [ "$CODE" = "124" ] || [ "$CODE" = "137" ]; then
    REPORT="{\"outcome\":\"timeout\",\"summary\":\"Stopped at the $TIMEOUT_MIN-minute limit.\"}"
  else
    REPORT="{\"outcome\":\"unreported\",\"summary\":\"The session ended (exit $CODE) without a LOOP-RESULT line.\"}"
  fi
fi
# A run that never reached its result event (killed, crashed) records its cap as its cost, so the
# daily budget counts the expensive runs instead of treating them as free.
EXTRA="$(jq -cn --argjson r "$RESULT" --argjson rep "$REPORT" --arg model "$MODEL" --arg effort "$EFFORT" \
  --argjson code "$CODE" --arg log "$LOG" --argjson cap "$MAX_USD" \
  '{model:$model, effort:$effort, exit_code:$code, log:$log,
    cost_usd:($r.total_cost_usd // $cap), cost_estimated:($r.total_cost_usd == null),
    num_turns:($r.num_turns // null),
    duration_s:(if ($r.duration_ms | type) == "number" then ($r.duration_ms / 1000 | floor) else null end),
    session_id:($r.session_id // null),
    issues:(($rep.issues | arrays // []) | map(select(type == "number"))),
    prs:(($rep.prs | arrays // []) | map(select(type == "number")))}')" \
  || EXTRA="$(jq -cn --argjson cap "$MAX_USD" --argjson code "$CODE" '{cost_usd:$cap, cost_estimated:true, exit_code:$code}')"
journal "$(jq -r '.outcome | tostring' <<<"$REPORT")" "$(jq -r '.summary // "" | tostring' <<<"$REPORT")" "$EXTRA"

# Keep two weeks of logs.
find "$LOOP_HOME/logs" -type f \( -name '*.jsonl' -o -name '*.err' \) -mtime +14 -delete 2>/dev/null
exit "$CODE"
}

main "$@"
exit $?
