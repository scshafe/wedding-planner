#!/usr/bin/env bash
# Reporter precheck: always runs; says where the dashboard goes.
set -uo pipefail

last_report="$(jq -r 'select(.role == "reporter" and .outcome == "reported") | .started_at' \
  "${WP_LOOP_HOME:-$HOME/.wedding-planner-loop}/journal.jsonl" 2>/dev/null | tail -n 1)"

echo "### dashboard"
echo "- GitHub Pages: https://scshafe.github.io/wedding-planner/ (the gh-pages branch)"
echo "- claude.ai artifact (interactive sessions only): ${WP_DASHBOARD_URL:-not configured}"
echo "- last successful report: ${last_report:-never}"
