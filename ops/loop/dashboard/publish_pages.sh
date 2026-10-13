#!/usr/bin/env bash
# Publish the dashboard to GitHub Pages: the `gh-pages` branch holds one commit with the standalone
# page, replaced (force-pushed) on every publish, so the branch never accumulates history.
#
#   bash ops/loop/dashboard/publish_pages.sh <dashboard dir>     (the dir build_dashboard.ts wrote)
#
# The commit carries no workflow files, so pushing it starts no CI; Pages serves it once the owner
# turns Pages on for the gh-pages branch. Deterministic on purpose: the reporter's model writes
# the digest, this script (not the model) touches git.
set -euo pipefail

src="${1:?usage: publish_pages.sh <dashboard dir>}"
page="$src/site/index.html"
[ -s "$page" ] || { echo "no page at $page; run build_dashboard.ts first" >&2; exit 1; }

repo_url="https://github.com/scshafe/wedding-planner"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -C "$work" init --quiet --initial-branch=gh-pages
cp "$page" "$work/index.html"
touch "$work/.nojekyll"
git -C "$work" add index.html .nojekyll
git -C "$work" -c user.name="scshafe-agent[bot]" -c user.email="$(git config --global user.email || echo 'scshafe-agent[bot]@users.noreply.github.com')" \
  commit --quiet -m "Dashboard $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git -C "$work" push --quiet --force "$repo_url" gh-pages:gh-pages
echo "published $(wc -c < "$page") bytes to gh-pages"
