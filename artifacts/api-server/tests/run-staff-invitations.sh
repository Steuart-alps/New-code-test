#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19097
}

TEST_PORT="${TEST_PORT:-$(_free_port)}"
CAPTURE_DIR="$(mktemp -d)"
CAPTURE_FILE="${CAPTURE_DIR}/emails.jsonl"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$CAPTURE_DIR"
}
trap cleanup EXIT

pnpm run build
NODE_ENV=test TEST_EMAIL_CAPTURE_PATH="$CAPTURE_FILE" PORT="$TEST_PORT" \
  node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!

for _ in $(seq 1 45); do
  if curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || exit 1
  sleep 1
done
curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null

TEST_EMAIL_CAPTURE_PATH="$CAPTURE_FILE" node tests/staff-invitations.mjs