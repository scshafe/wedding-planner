#!/usr/bin/env bash
# Triage precheck: run when issues need shaping or the ready queue is below 3.
set -uo pipefail
# shellcheck source=../lib.sh
. "$(dirname "$0")/../lib.sh"

# Open issues with status:triage or no status:* label at all, except raw feedback (the feedback
# role's input).
untriaged="$(gh issue list -R "$REPO_SLUG" --state open --limit 200 --json number,title,labels,author --jq '
  map(select((.labels | map(.name)) as $l
      | ($l | index("type:feedback") | not)
        and (($l | index("status:triage")) or (($l | map(select(startswith("status:"))) | length) == 0))))
  | .[] | "- #\(.number) \(.title) (by \(.author.login); labels: \(.labels | map(.name) | join(", ")))"')" || exit 1
ready_count="$(gh issue list -R "$REPO_SLUG" --label status:ready --state open --limit 100 --json number --jq length)" || exit 1
needs_owner="$(issues_with_label status:needs-owner)" || exit 1
milestones="$(gh api "repos/$REPO_SLUG/milestones?state=open&per_page=100" \
  --jq '.[] | "- \(.title): \(.closed_issues) closed / \(.open_issues) open"')" || exit 1

if [ -z "$untriaged" ] && [ "$ready_count" -ge 3 ]; then
  exit 10
fi

echo "### issues to triage"
echo "${untriaged:-none}"
echo
echo "### ready queue: $ready_count issue(s) (keep it at 3-6)"
echo
echo "### open milestones"
echo "${milestones:-none}"
echo
echo "### waiting on the owner"
echo "${needs_owner:-none}"
