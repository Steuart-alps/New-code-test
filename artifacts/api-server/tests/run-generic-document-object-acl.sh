#!/usr/bin/env bash
# Self-sufficient runner for generic client-document object ACL coverage.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null || echo 19094
}

TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
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
node tests/generic-document-object-acl.mjs