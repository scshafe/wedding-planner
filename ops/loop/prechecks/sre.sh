#!/usr/bin/env bash
# SRE precheck: run when main's CI or the latest deploy failed in a run the SRE has not already
# been woken for, or when an incident is open that is not waiting on the owner. Waking once per
# failing run (not once per hour) bounds the cost while a problem waits on a human.
set -uo pipefail
# shellcheck source=../lib.sh
. "$(dirname "$0")/../lib.sh"

state_dir="${WP_LOOP_HOME:-$HOME/.wedding-planner-loop}/state"
seen_file="$state_dir/sre-seen-runs"
mkdir -p "$state_dir"
touch "$seen_file"

health_file="$(mktemp)"
trap 'rm -f "$health_file"' EXIT
main_health > "$health_file" || exit 1   # a redirect, not $(...), so MAIN_RED survives

new_red=""
for run_id in ${MAIN_RED_RUNS:-}; do
  grep -qx "$run_id" "$seen_file" || new_red+=" $run_id"
done

# Incidents the SRE can act on: not the ones already handed to the owner.
incidents="$(gh issue list -R "$REPO_SLUG" --label type:incident --state open --limit 50 --json number,title,labels,author \
  --jq '.[] | select(.labels | map(.name) | index("status:needs-owner") | not) | "\(.author.login)\t- #\(.number) \(.title)"')" || exit 1
actionable=""
while IFS=$'\t' read -r author line; do
  [ -n "$author" ] || continue
  trusted_actor "$author" && actionable+="$line"$'\n'
done <<<"$incidents"

if [ -z "$new_red" ] && [ -z "$actionable" ]; then
  exit 10
fi
for run_id in $new_red; do echo "$run_id" >> "$seen_file"; done

cat "$health_file"
echo "### failing runs you have not seen before:${new_red:- none}"
echo
echo "### open incidents you can act on"
echo "${actionable:-none}"
