#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
: "${DATABASE_URL:?Set DATABASE_URL to a development/test database; the suite deletes only its own fixture client}"
: "${SESSION_SECRET:?Set SESSION_SECRET for the test API}"

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null || echo 19098
}

TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="http://localhost:${TEST_PORT}/api"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

pnpm run build
NODE_ENV=test OBJECT_STORAGE_TEST_SIGNING_FAILURE=1 PORT="$TEST_PORT" \
  node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!
for _ in $(seq 1 45); do
  curl -sf -m 2 "http://localhost:${TEST_PORT}/readyz" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
curl -sf -m 2 "http://localhost:${TEST_PORT}/readyz" >/dev/null || {
  echo "storage-outage-routes: the test API on port ${TEST_PORT} never became ready; no routes were checked" >&2
  exit 1
}
node tests/storage-outage-routes.mjs