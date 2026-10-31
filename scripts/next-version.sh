#!/usr/bin/env bash
# The next release's version, Home Assistant style: year.month.patch — this month's first is YEAR.MONTH.0 (no leading
# zero: 2026.1.0), each later one this month adds one to the patch. If main is already a release, that release.
#   scripts/next-version.sh [repo]   (reads the tags; fetch them first)
set -euo pipefail
repo=${1:-.}
if exact=$(git -C "$repo" describe --tags --exact-match --match '20[0-9][0-9].*' main 2>/dev/null); then
  echo "$exact"
  exit 0
fi
month=$(TZ=America/Denver date +%Y).$(TZ=America/Denver date +%-m)
last=$(git -C "$repo" tag --list "$month.*" | sed "s/^$month\.//" | grep -E '^[0-9]+$' | sort -n | tail -1 || true)
echo "$month.$(( ${last:--1} + 1 ))"
