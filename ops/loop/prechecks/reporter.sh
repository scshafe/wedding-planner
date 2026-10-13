#!/usr/bin/env bash
# Reporter precheck: needs the dashboard artifact's URL (set WP_DASHBOARD_URL in config.env).
set -uo pipefail

if [ -z "${WP_DASHBOARD_URL:-}" ]; then
  echo "WP_DASHBOARD_URL is not set in \$WP_LOOP_HOME/config.env; the reporter has nowhere to publish."
  exit 11
fi
last_report="$(jq -r 'select(.role == "reporter" and .outcome == "reported") | .started_at' \
  "$WP_LOOP_HOME/journal.jsonl" 2>/dev/null | tail -n 1)"

echo "### dashboard"
echo "- artifact: $WP_DASHBOARD_URL"
echo "- last successful report: ${last_report:-never}"
