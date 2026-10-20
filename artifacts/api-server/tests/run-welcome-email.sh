#!/usr/bin/env bash
# Self-sufficient runner for the self-signup welcome email suite and its
# verification resend. Each case (success, delay, reject) boots a private API
# on a free port with the test email transport, so no mailbox or provider
# quota is used. The shared integration lock keeps it from overlapping the
# other API suites.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
: "${DATABASE_URL:?DATABASE_URL is required: the private API needs a database}"

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19098
}

TEST_EMAIL_DELAY_MS="${TEST_EMAIL_DELAY_MS:-2500}"
SERVER_PID=""
CAPTURE_DIR=""
LOG_FILE=""
CASE=""

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

# On failure, name the case and show the end of its API log after the
# suite's own failure list.
cleanup() {
  local status=$?
  stop_server
  if [ "$status" -ne 0 ] && [ -n "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    echo "--- welcome email (${CASE}): last 80 lines of the test API log ---" >&2
    tail -n 80 "$LOG_FILE" >&2
  fi
  if [ -n "$CAPTURE_DIR" ]; then rm -rf "$CAPTURE_DIR"; fi
  exit "$status"
}
trap cleanup EXIT

pnpm run build

run_case() {
  local behavior="$1"
  local port="$(_free_port)"
  CAPTURE_DIR="$(mktemp -d)"
  local capture_file="${CAPTURE_DIR}/emails.jsonl"
  LOG_FILE="${CAPTURE_DIR}/server.log"
  local api_base="http://127.0.0.1:${port}/api"
  CASE="$behavior"

  NODE_ENV=test \
    TEST_EMAIL_CAPTURE_PATH="$capture_file" \
    TEST_EMAIL_BEHAVIOR="$behavior" \
    TEST_EMAIL_DELAY_MS="$TEST_EMAIL_DELAY_MS" \
    ADMIN_EMAIL="alps-admin@test.local" \
    PORT="$port" \
    node --enable-source-maps ./dist/index.mjs >"$LOG_FILE" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 "${API_TEST_READY_TIMEOUT:-180}"); do
    if curl -sf -m 2 "${api_base%/api}/readyz" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "Welcome email (${behavior}): the test API exited before becoming ready" >&2
      exit 1
    fi
    sleep 1
  done
  if ! curl -sf -m 2 "${api_base%/api}/readyz" >/dev/null; then
    echo "Welcome email (${behavior}): the test API did not become ready at ${api_base}" >&2
    exit 1
  fi

  API_BASE="$api_base" \
    TEST_EMAIL_CAPTURE_PATH="$capture_file" \
    TEST_EMAIL_SCENARIO="$behavior" \
    TEST_EMAIL_DELAY_MS="$TEST_EMAIL_DELAY_MS" \
    node tests/welcome-email.mjs

  # The rejected send is intentionally handled by the registration route's
  # promise catch, so allow the logger one tick before checking its output.
  if [ "$behavior" = "reject" ]; then
    sleep 1
    for expected in "Failed to send welcome email" "Failed to send new sign-up alert" "Failed to resend verification email"; do
      if ! grep -q "$expected" "$LOG_FILE"; then
        echo "Welcome email (reject): the API log has no \"${expected}\" entry" >&2
        exit 1
      fi
    done
  fi

  stop_server
  rm -rf "$CAPTURE_DIR"
  CAPTURE_DIR=""
  LOG_FILE=""
}

run_case success
run_case delay
run_case reject