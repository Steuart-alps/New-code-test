#!/usr/bin/env bash
# Self-sufficient runner for the department-isolation test suite.
#
# The test needs a live API server. If one is already answering on
# $API_BASE/healthz we use it; otherwise we build and boot a private
# instance on TEST_PORT, run the tests against it, and shut it down.
set -euo pipefail

cd "$(dirname "$0")/.."

TEST_PORT="${TEST_PORT:-8080}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"

healthy() {
  curl -sf -m 2 "${API_BASE}/healthz" >/dev/null 2>&1
}

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! healthy; then
  echo "No API server responding at ${API_BASE} — starting a test instance..."
  pnpm run build
  NODE_ENV=development PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 30); do
    if healthy; then break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "API server process exited before becoming healthy" >&2
      exit 1
    fi
    sleep 1
  done
  if ! healthy; then
    echo "API server did not become healthy at ${API_BASE} within 30s" >&2
    exit 1
  fi
fi

node tests/dept-isolation.mjs
