#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
TEST_PORT="${TEST_PORT:-19097}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
ready() { curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1; }
SERVER_PID=""
cleanup() { [ -z "$SERVER_PID" ] || { kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; }; }
trap cleanup EXIT
if ! ready; then
  pnpm run build
  NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 45); do ready && break; kill -0 "$SERVER_PID" 2>/dev/null || exit 1; sleep 1; done
  ready || exit 1
fi
node tests/staff-attribution.mjs