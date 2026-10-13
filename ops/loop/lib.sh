# Shared helpers for the loop's prechecks (sourced, not run). Prechecks print the run context the
# role's session will see and exit 0 (run), 10 (nothing to do) or 11 (not configured).
# Environment from run-role.sh: REPO_SLUG, WP_LOOP_TRUSTED_ACTORS, WP_LOOP_HOME.

REPO_SLUG="${REPO_SLUG:-scshafe/wedding-planner}"
TRUSTED_ACTORS="${WP_LOOP_TRUSTED_ACTORS:-scshafe scshafe-agent[bot] app/scshafe-agent}"

# Is $1 one of the trusted actors (the owner or the loop's bot)?
trusted_actor() {
  local who="$1" t
  for t in $TRUSTED_ACTORS; do [ "$who" = "$t" ] && return 0; done
  return 1
}

# Who applied status:ready to issue $1 most recently? Labels confer authority only from a trusted
# actor: the repository is public, and issue forms can apply labels for anyone.
ready_labeler() {
  gh api "repos/$REPO_SLUG/issues/$1/events" --paginate \
    --jq '.[] | select(.event == "labeled" and .label.name == "status:ready") | .actor.login' | tail -n 1
}

# Print main's CI and deploy state; set MAIN_RED=1 when either most recent completed run failed.
main_health() {
  MAIN_RED=0
  local wf line conclusion
  echo "### main health"
  for wf in ci.yml deploy.yml; do
    line="$(gh run list -R "$REPO_SLUG" --workflow "$wf" --branch main --limit 5 \
      --json status,conclusion,headSha,createdAt,url,displayTitle \
      --jq '[.[] | select(.status == "completed" and .conclusion != "cancelled" and .conclusion != "skipped")][0]
            // empty | "\(.conclusion)\t\(.headSha[0:7])\t\(.createdAt)\t\(.url)\t\(.displayTitle)"')" || return 1
    if [ -z "$line" ]; then
      echo "- $wf on main: no completed run yet"
      continue
    fi
    conclusion="${line%%$'\t'*}"
    IFS=$'\t' read -r _ sha at url title <<<"$line"
    echo "- $wf on main: **$conclusion** at $sha ($at) \"$title\" $url"
    [ "$conclusion" = "success" ] || MAIN_RED=1
  done
  echo
}

# Print open issues with label $1 as a markdown list (number, title, author).
issues_with_label() {
  gh issue list -R "$REPO_SLUG" --label "$1" --state open --limit 100 --json number,title,author \
    --jq '.[] | "- #\(.number) \(.title) (by \(.author.login))"'
}
