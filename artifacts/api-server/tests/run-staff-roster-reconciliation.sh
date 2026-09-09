#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
_free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19095; }
TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
ready() { curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1; }
SERVER_PID=""
cleanup() { [ -z "$SERVER_PID" ] || { kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; }; }
trap cleanup EXIT
if ! ready; then
  pnpm run build
  NODE_ENV=test PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 45); do ready && break; kill -0 "$SERVER_PID" 2>/dev/null || exit 1; sleep 1; done
  ready || { echo "API server did not become ready" >&2; exit 1; }
fi
node tests/staff-roster-reconciliation.mjs