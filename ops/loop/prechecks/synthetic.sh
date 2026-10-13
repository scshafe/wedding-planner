#!/usr/bin/env bash
# Synthetic-users precheck: always runs; picks today's persona and a local port.
set -uo pipefail

personas=(planner couple guest)
day_of_year="$(date -u +%j)"
persona="${personas[$(( 10#$day_of_year % 3 ))]}"

echo "### today's persona: $persona"
echo "- local port for the app: 18181 (HOST=127.0.0.1)"
echo "- persona seeds you may draw on: eval-harness/ (couple and guest personas, scenarios)"
