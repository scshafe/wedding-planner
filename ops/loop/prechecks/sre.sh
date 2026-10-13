#!/usr/bin/env bash
# SRE precheck: run only when main's CI or the latest deploy failed, or an incident is open.
set -uo pipefail
# shellcheck source=../lib.sh
. "$(dirname "$0")/../lib.sh"

health_file="$(mktemp)"
trap 'rm -f "$health_file"' EXIT
main_health > "$health_file" || exit 1   # a redirect, not $(...), so MAIN_RED survives
incidents="$(issues_with_label type:incident)" || exit 1

if [ "$MAIN_RED" = 0 ] && [ -z "$incidents" ]; then
  exit 10
fi

cat "$health_file"
echo "### open incidents"
echo "${incidents:-none}"
