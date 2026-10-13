# shellcheck shell=bash
# Shared helpers for the loop's prechecks (sourced, not run). Prechecks print the run context the
# role's session will see and exit 0 (run), 10 (nothing to do) or 11 (not configured).
# Environment from run-role.sh: REPO_SLUG, WP_LOOP_HOME.

REPO_SLUG="${REPO_SLUG:-scshafe/wedding-planner}"
OWNER_LOGIN="scshafe"

# The actors whose labels and issues confer authority: the owner and the loop's bot (as the events
# API and gh print it). Hard-coded on purpose: no file or variable an agent can write may widen it.
TRUSTED_ACTORS=("$OWNER_LOGIN" "scshafe-agent[bot]" "app/scshafe-agent")

# Is $1 one of the trusted actors? (An exact string match; no globbing of "[bot]".)
trusted_actor() {
  local t
  for t in "${TRUSTED_ACTORS[@]}"; do [ "$1" = "$t" ] && return 0; done
  return 1
}

# Who most recently applied label $2 to issue $1? Prints nothing if nobody ever did.
last_labeler() {
  gh api "repos/$REPO_SLUG/issues/$1/events" --paginate \
    --jq ".[] | select(.event == \"labeled\" and .label.name == \"$2\") | .actor.login" | tail -n 1
}

# Was label $2 ever applied to issue $1 (even if it was removed later)?
ever_labeled() {
  local n
  n="$(gh api "repos/$REPO_SLUG/issues/$1/events" --paginate \
    --jq "[.[] | select(.event == \"labeled\" and .label.name == \"$2\")] | length" | awk '{ s += $1 } END { print s + 0 }')" || return 2
  [ "$n" -gt 0 ]
}

# May the builder work issue $1 (author $2)? Prints the reason and returns 1 when it may not.
#   - a trusted actor wrote it (an author can edit the body after it was labeled), and
#   - a trusted actor applied status:ready, and
#   - if it ever carried source:customer (work derived from a stranger's feedback), the owner
#     applied status:ready: the bot cannot promote what a stranger's text produced.
builder_may_work() {
  local number="$1" author="$2" who
  if ! trusted_actor "$author"; then
    echo "written by '$author', who is not trusted (they can still edit it); triage should rewrite it as a new issue"
    return 1
  fi
  who="$(last_labeler "$number" status:ready)" || { echo "could not read its event log"; return 1; }
  if ! trusted_actor "$who"; then
    echo "status:ready was applied by '${who:-nobody on record}', who is not trusted"
    return 1
  fi
  ever_labeled "$number" source:customer
  case $? in
    0) if [ "$who" != "$OWNER_LOGIN" ]; then
         echo "it comes from customer feedback, so only the owner's status:ready counts (it was '$who')"
         return 1
       fi ;;
    1) ;;
    *) echo "could not read its event log"; return 1 ;;
  esac
  return 0
}

# Print main's CI and deploy state; set MAIN_RED=1 when either most recent decided run failed.
# Only runs that main itself triggered count: a fork's pull request from its own branch named
# "main" also reports headBranch "main", so the event is filtered too.
# shellcheck disable=SC2034  # MAIN_RED and MAIN_RED_RUNS are read by the sourcing precheck
main_health() {
  MAIN_RED=0
  local wf line conclusion sha at url title
  echo "### main health"
  for wf in ci.yml deploy.yml; do
    line="$(gh run list -R "$REPO_SLUG" --workflow "$wf" --branch main --limit 10 \
      --json status,conclusion,headSha,createdAt,url,displayTitle,event,databaseId \
      --jq '[.[] | select((.event == "push" or .event == "workflow_dispatch")
                          and .status == "completed" and .conclusion != "cancelled" and .conclusion != "skipped")][0]
            // empty | "\(.conclusion)\t\(.headSha[0:7])\t\(.createdAt)\t\(.url)\t\(.databaseId)\t\(.displayTitle)"')" || return 1
    if [ -z "$line" ]; then
      echo "- $wf on main: no completed run yet"
      continue
    fi
    IFS=$'\t' read -r conclusion sha at url run_id title <<<"$line"
    echo "- $wf on main: **$conclusion** at $sha ($at) run $run_id \"$title\" $url"
    if [ "$conclusion" != "success" ]; then
      MAIN_RED=1
      MAIN_RED_RUNS="${MAIN_RED_RUNS:-} $run_id"
    fi
  done
  echo
}

# Print open issues with label $1 as a markdown list (number, title, author). Callers that pass the
# list to a model must only use it for labels that strangers cannot apply.
issues_with_label() {
  gh issue list -R "$REPO_SLUG" --label "$1" --state open --limit 100 --json number,title,author \
    --jq '.[] | "- #\(.number) \(.title) (by \(.author.login))"'
}
