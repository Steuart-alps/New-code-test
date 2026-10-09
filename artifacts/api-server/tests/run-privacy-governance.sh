#!/usr/bin/env bash
# Self-sufficient integration test runner for the privacy governance centre.
set -euo pipefail

cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null || echo 19092
}
TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"

healthy() {
  curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1
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
  echo "No ready API server at ${API_BASE} — starting a test instance..."
  pnpm run build
  NODE_ENV=test OBJECT_STORAGE_TEST_FAKE_USAGE=1 PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 90); do
    if healthy; then break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "API server exited before becoming ready" >&2
      exit 1
    fi
    sleep 1
  done
  if ! healthy; then
    echo "API server did not become ready at ${API_BASE} within 90s" >&2
    exit 1
  fi
fi

node tests/privacy-governance.mjs