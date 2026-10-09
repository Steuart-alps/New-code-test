#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19098
}

TEST_EMAIL_DELAY_MS="${TEST_EMAIL_DELAY_MS:-2500}"
SERVER_PID=""
CAPTURE_DIR=""
LOG_FILE=""

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

cleanup() {
  stop_server
  if [ -n "$CAPTURE_DIR" ]; then rm -rf "$CAPTURE_DIR"; fi
}
trap cleanup EXIT

pnpm run build

run_case() {
  local behavior="$1"
  local port="$(_free_port)"
  CAPTURE_DIR="$(mktemp -d)"
  local capture_file="${CAPTURE_DIR}/emails.jsonl"
  LOG_FILE="${CAPTURE_DIR}/server.log"
  local api_base="http://localhost:${port}/api"

  NODE_ENV=test \
    TEST_EMAIL_CAPTURE_PATH="$capture_file" \
    TEST_EMAIL_BEHAVIOR="$behavior" \
    TEST_EMAIL_DELAY_MS="$TEST_EMAIL_DELAY_MS" \
    PORT="$port" \
    node --enable-source-maps ./dist/index.mjs >"$LOG_FILE" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 45); do
    if curl -sf -m 2 "${api_base%/api}/readyz" >/dev/null 2>&1; then break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || exit 1
    sleep 1
  done
  curl -sf -m 2 "${api_base%/api}/readyz" >/dev/null

  API_BASE="$api_base" \
    TEST_EMAIL_CAPTURE_PATH="$capture_file" \
    TEST_EMAIL_SCENARIO="$behavior" \
    TEST_EMAIL_DELAY_MS="$TEST_EMAIL_DELAY_MS" \
    node tests/welcome-email.mjs

  # The rejected send is intentionally handled by the registration route's
  # promise catch, so allow the logger one tick before checking its output.
  if [ "$behavior" = "reject" ]; then
    sleep 1
    grep -q "Failed to send welcome email" "$LOG_FILE"
  fi

  stop_server
  rm -rf "$CAPTURE_DIR"
  CAPTURE_DIR=""
  LOG_FILE=""
}

run_case success
run_case delay
run_case reject