#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19096
}

TEST_PORT="${TEST_PORT:-$(_free_port)}"
LOCAL_API_BASE="http://127.0.0.1:${TEST_PORT}/api"
READY_URL="http://127.0.0.1:${TEST_PORT}/readyz"
if [ -n "${API_BASE:-}" ] &&
  [ "$API_BASE" != "$LOCAL_API_BASE" ] &&
  [ "$API_BASE" != "http://localhost:${TEST_PORT}/api" ]; then
  echo "API_BASE overrides are not supported by this self-booting test; unset API_BASE to use its private local server." >&2
  exit 2
fi
export API_BASE="$LOCAL_API_BASE"
umask 077
CAPTURE_DIR="$(mktemp -d)"
CAPTURE_FILE="${CAPTURE_DIR}/emails.jsonl"
SERVER_LOG="${CAPTURE_DIR}/server.log"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$CAPTURE_DIR"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
touch "$CAPTURE_FILE"

if curl -sf -m 2 "$READY_URL" >/dev/null 2>&1; then
  echo "A ready API already occupies TEST_PORT; refusing to reuse it. Choose a free TEST_PORT." >&2
  exit 1
fi

pnpm run build
NODE_ENV=test TEST_EMAIL_CAPTURE_PATH="$CAPTURE_FILE" TEST_EMAIL_BEHAVIOR=success PORT="$TEST_PORT" \
  node --enable-source-maps ./dist/index.mjs >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 45); do
  kill -0 "$SERVER_PID" 2>/dev/null || {
    echo "Test API server exited before becoming ready." >&2
    exit 1
  }
  curl -sf -m 2 "$READY_URL" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 2 "$READY_URL" >/dev/null || {
  echo "Test API server did not become ready at $READY_URL within 45s." >&2
  exit 1
}
node tests/twofa-recovery.mjs "$@"