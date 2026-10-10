#!/usr/bin/env bash
# Self-sufficient runner for the module-routes happy-path test suite.
#
# Always boot a private test instance; never reuse the development API.
set -euo pipefail

cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
command -v psql >/dev/null || { echo "psql is required for the DocTrack fixture and per-run cleanup" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL is required: the private API and fixture cleanup must share one database}"

# Pick a free ephemeral port if none is set. Falls back to 19090 if python3
# is unavailable (unlikely in this environment).
_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null || echo 19090
}
TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="http://127.0.0.1:${TEST_PORT}/api"

healthy() {
  curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1
}

SERVER_PID=""
CAPTURE_DIR="$(mktemp -d)"
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$CAPTURE_DIR"
}
trap cleanup EXIT

if healthy; then
  echo "Refusing to reuse an API already listening on TEST_PORT=$TEST_PORT" >&2
  exit 1
fi
{
  echo "No API server responding at ${API_BASE} — starting a test instance..."
  pnpm run build
  NODE_ENV=test ENFORCE_MANDATORY_2FA=1 TEST_EMAIL_CAPTURE_PATH="$CAPTURE_DIR/emails.jsonl" PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 "${API_TEST_READY_TIMEOUT:-180}"); do
    if healthy; then break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "API server process exited before becoming healthy" >&2
      exit 1
    fi
    sleep 1
  done
  if ! healthy; then
    echo "API server did not become ready at ${API_BASE}" >&2
    exit 1
  fi
}

# Mandatory 2FA is enforced: fixtures enrol TOTP and must never accept a
# password-only session.
env -u ALLOW_PASSWORD_ONLY_TEST_LOGIN node tests/module-routes.mjs
