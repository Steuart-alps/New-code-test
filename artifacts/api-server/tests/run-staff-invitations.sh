#!/usr/bin/env bash
# Self-sufficient runner for the staff invitation suite (invite, resend,
# revoke, setup state in User Management).
#
# Always boots a private API on a free port with email capture on, so no
# mailbox is needed and it never reuses the development API. The shared
# integration lock keeps it from overlapping the other API suites.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
command -v psql >/dev/null || { echo "psql is required: the suite reads and ages setup links directly" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL is required: the private API and the suite must share one database}"

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19097
}

TEST_PORT="${TEST_PORT:-$(_free_port)}"
CAPTURE_DIR="$(mktemp -d)"
CAPTURE_FILE="${CAPTURE_DIR}/emails.jsonl"
SERVER_LOG="${CAPTURE_DIR}/api.log"
export API_BASE="http://127.0.0.1:${TEST_PORT}/api"
SERVER_PID=""

healthy() {
  curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1
}

# On failure, show the end of the private API's log after the suite's own
# failure list, so a broken invitation can be traced from the CI output.
cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -s "$SERVER_LOG" ]; then
    echo "--- staff invitations: last 80 lines of the test API log ---" >&2
    tail -n 80 "$SERVER_LOG" >&2
  fi
  rm -rf "$CAPTURE_DIR"
  exit "$status"
}
trap cleanup EXIT

if healthy; then
  echo "Refusing to reuse an API already listening on TEST_PORT=$TEST_PORT" >&2
  exit 1
fi

pnpm run build
# The first invitation email this API sends is rejected, so the suite can
# check what an admin sees when a new staff member's invitation bounces.
NODE_ENV=test TEST_EMAIL_CAPTURE_PATH="$CAPTURE_FILE" PORT="$TEST_PORT" \
  TEST_EMAIL_REJECT_SUBJECT="You've been invited to ComplyTrack" TEST_EMAIL_REJECT_SUBJECT_OCCURRENCE=1 \
  node --enable-source-maps ./dist/index.mjs >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 "${API_TEST_READY_TIMEOUT:-180}"); do
  if healthy; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Staff invitations: the test API exited before becoming ready" >&2
    exit 1
  fi
  sleep 1
done
if ! healthy; then
  echo "Staff invitations: the test API did not become ready at ${API_BASE}" >&2
  exit 1
fi

TEST_EMAIL_CAPTURE_PATH="$CAPTURE_FILE" node tests/staff-invitations.mjs
