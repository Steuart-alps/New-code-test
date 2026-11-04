#!/usr/bin/env bash
set -euo pipefail

# Self-sufficient runner for the Owner and Manager role tests.
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null || echo 19098
}

TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

if ! curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1; then
  pnpm run build
  # The every-business checks need to know the platform operator's address
  # before the API starts, so they only run against an API booted here.
  # Fixture cleanup only purges accounts whose address carries the run id.
  export TEST_RUN_ID="${TEST_RUN_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
  export PLATFORM_OPERATOR_EMAIL="manager-role-operator-${TEST_RUN_ID}@test.local"
  NODE_ENV=test PORT="$TEST_PORT" PLATFORM_ADMIN_EMAILS="$PLATFORM_OPERATOR_EMAIL" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 45); do
    curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null
node tests/manager-role.mjs