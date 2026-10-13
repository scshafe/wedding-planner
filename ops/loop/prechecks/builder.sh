#!/usr/bin/env bash
# Builder precheck: is there a red main, a loop PR to finish, an issue in progress, or an eligible
# ready issue? Every issue passes builder_may_work (lib.sh): trusted author, trusted status:ready,
# and the owner's status:ready for anything derived from customer feedback.
set -uo pipefail
# shellcheck source=../lib.sh
. "$(dirname "$0")/../lib.sh"

main_health > "${TMPDIR:-/tmp}/wp-loop-builder-health.$$" || exit 1
health="$(cat "${TMPDIR:-/tmp}/wp-loop-builder-health.$$")"
rm -f "${TMPDIR:-/tmp}/wp-loop-builder-health.$$"

# Only the loop's own PRs: the label alone is not enough, the bot must have opened it.
open_prs="$(gh pr list -R "$REPO_SLUG" --label loop:pr --state open --json number,title,headRefName,url,author \
  --jq '.[] | "\(.author.login)\t- PR #\(.number) \(.title) (branch \(.headRefName)) \(.url)"')" || exit 1
own_prs=""
while IFS=$'\t' read -r author line; do
  [ -n "$author" ] || continue
  trusted_actor "$author" && own_prs+="$line"$'\n'
done <<<"$open_prs"

# Ready and in-progress issues, best first: priority, then milestone order, then age.
list_ranked() {
  gh issue list -R "$REPO_SLUG" --label "$1" --state open --limit 100 \
    --json number,title,labels,milestone,author --jq '
      map({number, title, author: .author.login,
           prio: ((.labels | map(.name) | map(select(startswith("priority:"))) | sort | first) // "priority:P9"),
           ms: (.milestone.title // "no milestone"),
           msn: (.milestone.number // 999)})
      | sort_by(.prio, .msn, .number) | .[] | [.number, .author, .prio, .ms, .title] | @tsv'
}

refused=""
filter_eligible() { # label -> prints eligible lines, appends refusals to $refused
  local ranked number author prio milestone title reason out=""
  ranked="$(list_ranked "$1")" || return 1
  while IFS=$'\t' read -r number author prio milestone title; do
    [ -n "$number" ] || continue
    if reason="$(builder_may_work "$number" "$author")"; then
      out+="- #$number [${prio#priority:}, $milestone] $title"$'\n'
    else
      refused+="- #$number ($1): $reason. Do not work it."$'\n'
    fi
  done <<<"$ranked"
  printf '%s' "$out"
}
# Not in $(...): filter_eligible must append to $refused in this shell.
filter_eligible status:in-progress > "${TMPDIR:-/tmp}/wp-loop-builder-ip.$$" || exit 1
filter_eligible status:ready > "${TMPDIR:-/tmp}/wp-loop-builder-ready.$$" || exit 1
in_progress="$(cat "${TMPDIR:-/tmp}/wp-loop-builder-ip.$$")"
eligible="$(cat "${TMPDIR:-/tmp}/wp-loop-builder-ready.$$")"
rm -f "${TMPDIR:-/tmp}/wp-loop-builder-ip.$$" "${TMPDIR:-/tmp}/wp-loop-builder-ready.$$"

if [ "$MAIN_RED" = 0 ] && [ -z "$own_prs" ] && [ -z "$in_progress" ] && [ -z "$eligible" ]; then
  exit 10
fi

echo "$health"
echo "### open loop PRs (finish these first)"
echo "${own_prs:-none}"
echo
echo "### issues in progress (resume these before starting new work)"
echo "${in_progress:-none}"
echo
echo "### eligible ready issues, best first"
echo "${eligible:-none}"
if [ -n "$refused" ]; then
  echo
  echo "### issues you must NOT work"
  echo "$refused"
fi
