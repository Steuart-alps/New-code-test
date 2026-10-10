#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

TEST_PORT="${TEST_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')}"
export API_BASE="http://localhost:${TEST_PORT}/api"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

pnpm run build
NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 OBJECT_STORAGE_TEST_FAKE_USAGE=1 PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!
for _ in $(seq 1 45); do
  curl -sf -m 2 "http://localhost:${TEST_PORT}/readyz" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "Test API exited early" >&2; exit 1; }
  sleep 1
done
curl -sf -m 2 "http://localhost:${TEST_PORT}/readyz" >/dev/null
node tests/legionella-hot-tub-safety.mjs