#!/usr/bin/env bash
# Pure unit-test runner for TypeScript test files that need bundling.
#
# Usage: bash tests/run-bundled-unit.sh tests/<file>.ts <cjs|esm>
#
# The bundle goes to a unique private temp directory (never a fixed /tmp path
# shared by concurrent runs or other users) and is removed afterwards. The test
# runs with DATABASE_URL pointed at an unresolvable placeholder: some source
# modules import @workspace/db, which builds a lazy pool at import time, so a
# pure test may load them but can never reach the shared development database.
set -euo pipefail
cd "$(dirname "$0")/.."
entry="${1:?usage: run-bundled-unit.sh tests/<file>.ts <cjs|esm>}"
format="${2:?usage: run-bundled-unit.sh tests/<file>.ts <cjs|esm>}"
case "$format" in
  cjs) ext=cjs ;;
  esm) ext=mjs ;;
  *) echo "format must be cjs or esm" >&2; exit 2 ;;
esac
out="$(mktemp -d "${TMPDIR:-/tmp}/complytrack-unit-XXXXXX")"
trap 'rm -rf "$out"' EXIT
bundle="$out/$(basename "$entry" .ts).$ext"
pnpm exec esbuild "$entry" --bundle --platform=node --format="$format" --log-level=warning --outfile="$bundle"
DATABASE_URL="postgresql://no-shared-database.invalid/pure-unit-test" node "$bundle"
