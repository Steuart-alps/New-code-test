#!/usr/bin/env bash
# Reproduce the launch group's parallel scheduling, then bypass the outer lock
# deliberately for two scoped trial jobs to prove fixture ownership itself.
set -euo pipefail
cd "$(dirname "$0")/.."
logs="$(mktemp -d "${TMPDIR:-/tmp}/complytrack-launch-checks.XXXXXX")"
pids=()
labels=()
launch() {
  local label="$1"; shift
  labels+=("$label")
  "$@" >"$logs/$label.log" 2>&1 &
  pids+=("$!")
}
finish_group() {
  local failed=0
  for index in "${!pids[@]}"; do
    if wait "${pids[$index]}"; then
      echo "PASS: ${labels[$index]}"
      grep -E 'checks passed|serializes concurrent' "$logs/${labels[$index]}.log" || true
    else
      failed=1
      echo "FAIL: ${labels[$index]}" >&2
      tail -80 "$logs/${labels[$index]}.log" >&2
    fi
  done
  pids=()
  labels=()
  if [ "$failed" -ne 0 ]; then
    echo "Launch-check logs retained at $logs" >&2
    exit 1
  fi
}
launch trial-a pnpm run test:trial-reminders
launch trial-b pnpm run test:trial-reminders
launch modules pnpm run test:modules:ci
launch config pnpm run test:config:ci
finish_group
launch scoped-trial-a node tests/trial-reminders.mjs
launch scoped-trial-b node tests/trial-reminders.mjs
finish_group
rm -rf "$logs"
echo "Concurrent launch checks and independent trial fixtures passed."