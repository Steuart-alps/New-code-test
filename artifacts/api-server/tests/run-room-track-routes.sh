#!/usr/bin/env bash
# Boots a private API only when one is not already ready, then runs RoomTrack coverage.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
_free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19091; }
TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
READY_URL="${API_BASE%/api}/readyz"
healthy() { curl -sf -m 2 "$READY_URL" >/dev/null 2>&1; }
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
if ! healthy; then
  pnpm run build
  NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 30); do healthy && break; sleep 1; done
  healthy || { echo "API did not become ready at $READY_URL" >&2; exit 1; }
fi
node tests/room-track-routes.mjs