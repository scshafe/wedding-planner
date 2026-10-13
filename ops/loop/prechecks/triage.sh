#!/usr/bin/env bash
# Triage precheck: run when trusted-authored issues need shaping or the ready queue is below 3.
#
# Issues written by anyone else are handled here, in the shell, without a model reading them:
# they get type:feedback + status:triage (the feedback role's input, if the owner has enabled it)
# and never reach triage's context. Strangers' text reaches a model only through the feedback role.
set -uo pipefail
# shellcheck source=../lib.sh
. "$(dirname "$0")/../lib.sh"

# Open issues with status:triage or no status:* label at all, except raw feedback.
candidates="$(gh issue list -R "$REPO_SLUG" --state open --limit 200 --json number,title,labels,author --jq '
  map(select((.labels | map(.name)) as $l
      | ($l | index("type:feedback") | not)
        and (($l | index("status:triage")) or (($l | map(select(startswith("status:")))) | length) == 0)))
  | .[] | [.number, .author.login, (.labels | map(.name) | join(", ")), .title] | @tsv')" || exit 1

untriaged=""
while IFS=$'\t' read -r number author labels title; do
  [ -n "$number" ] || continue
  if trusted_actor "$author"; then
    untriaged+="- #$number $title (labels: ${labels:-none})"$'\n'
  else
    gh issue edit "$number" -R "$REPO_SLUG" --add-label type:feedback --add-label status:triage >/dev/null || exit 1
  fi
done <<<"$candidates"

ready_count="$(gh issue list -R "$REPO_SLUG" --label status:ready --state open --limit 100 --json number --jq length)" || exit 1
needs_owner="$(gh issue list -R "$REPO_SLUG" --label status:needs-owner --state open --limit 100 --json number,title,author \
  --jq '.[] | "\(.author.login)\t- #\(.number) \(.title)"')" || exit 1
owner_queue=""
while IFS=$'\t' read -r author line; do
  [ -n "$author" ] || continue
  trusted_actor "$author" && owner_queue+="$line"$'\n'
done <<<"$needs_owner"
milestones="$(gh api "repos/$REPO_SLUG/milestones?state=open&per_page=100" \
  --jq '.[] | "- \(.title) (#\(.number)): \(.closed_issues) closed / \(.open_issues) open"')" || exit 1

if [ -z "$untriaged" ] && [ "$ready_count" -ge 3 ]; then
  exit 10
fi

echo "### issues to triage (all written by trusted actors)"
echo "${untriaged:-none}"
echo
echo "### ready queue: $ready_count issue(s) (keep it at 3-6)"
echo
echo "### open milestones"
echo "${milestones:-none}"
echo
echo "### waiting on the owner"
echo "${owner_queue:-none}"
