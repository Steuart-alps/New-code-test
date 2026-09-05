#!/usr/bin/env bash
# Self-sufficient runner for FixTrack contractor-email approval coverage.
set -euo pipefail
cd "$(dirname "$0")/.."

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null || echo 19095
}

TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
export FIXTRACK_TEST_EMAIL_OUTBOX="${FIXTRACK_TEST_EMAIL_OUTBOX:-$(mktemp)}"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$FIXTRACK_TEST_EMAIL_OUTBOX"
}
trap cleanup EXIT

if ! curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1; then
  pnpm run build
  NODE_ENV=test PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 45); do
    curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1 && break
    sleep 1
  done
fi

curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null
node tests/fix-track-contractor-approval.mjs