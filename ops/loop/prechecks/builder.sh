#!/usr/bin/env bash
# Builder precheck: is there a red main, a loop PR to finish, an issue in progress, or an eligible
# ready issue? Eligible = status:ready applied by a trusted actor. Ranked by priority, milestone, age.
set -uo pipefail
# shellcheck source=../lib.sh
. "$(dirname "$0")/../lib.sh"

main_health || exit 1

open_prs="$(gh pr list -R "$REPO_SLUG" --label loop:pr --state open --json number,title,headRefName,url \
  --jq '.[] | "- PR #\(.number) \(.title) (branch \(.headRefName)) \(.url)"')" || exit 1
in_progress="$(issues_with_label status:in-progress)" || exit 1

ranked="$(gh issue list -R "$REPO_SLUG" --label status:ready --state open --limit 100 \
  --json number,title,labels,milestone --jq '
    map({number, title,
         prio: ((.labels | map(.name) | map(select(startswith("priority:"))) | sort | first) // "priority:P9"),
         ms: (.milestone.title // "no milestone"),
         msn: (.milestone.number // 999)})
    | sort_by(.prio, .msn, .number) | .[] | [.number, .prio, .ms, .title] | @tsv')" || exit 1

eligible=""
refused=""
while IFS=$'\t' read -r number prio milestone title; do
  [ -n "$number" ] || continue
  who="$(ready_labeler "$number")" || exit 1
  if trusted_actor "$who"; then
    eligible+="- #$number [${prio#priority:}, $milestone] $title"$'\n'
  else
    refused+="- #$number: status:ready was applied by '$who', who is not trusted. Do not work it."$'\n'
  fi
done <<<"$ranked"

if [ "$MAIN_RED" = 0 ] && [ -z "$open_prs" ] && [ -z "$in_progress" ] && [ -z "$eligible" ]; then
  exit 10
fi

echo "### open loop PRs (finish these first)"
echo "${open_prs:-none}"
echo
echo "### issues in progress (resume these before starting new work)"
echo "${in_progress:-none}"
echo
echo "### eligible ready issues, best first"
echo "${eligible:-none}"
if [ -n "$refused" ]; then
  echo
  echo "### ready-labeled issues that are NOT eligible"
  echo "$refused"
fi
