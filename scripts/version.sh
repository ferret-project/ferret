#!/usr/bin/env bash
# Which Ferret this checkout is (FERRET_VERSION): the release tag on it (2026.10.0 — Home Assistant's year.month.patch),
# or `git describe` past the last release (2026.10.0-3-gabc1234), or the commit before there were any releases.
set -euo pipefail
git -C "${1:-.}" describe --tags --match '20[0-9][0-9].*' --always 2>/dev/null || echo dev
