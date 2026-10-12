#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
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
NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null && break
  sleep 1
done
curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null
node tests/audit-log-endpoint.mjs