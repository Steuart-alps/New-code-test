#!/usr/bin/env bash
# Self-sufficient runner for the enforced-CSRF suite.
#
# Always boots a private test instance with ENFORCE_CSRF=1 (NODE_ENV=test
# otherwise skips the CSRF check); never reuses the development API.
set -euo pipefail

cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
command -v psql >/dev/null || { echo "psql is required for per-run fixture cleanup" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL is required: the private API and fixture cleanup must share one database}"

_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null || echo 19097
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

pnpm run build
# Mandatory 2FA keeps its test-mode bypass so the fixture can sign in directly;
# only the CSRF check is under test here. The API's own origin is its public
# app URL, as in production where it also serves the web build, so requests
# carrying a same-origin Origin header pass CORS and reach the CSRF check.
NODE_ENV=test ENFORCE_CSRF=1 ENFORCE_MANDATORY_2FA= PUBLIC_APP_URL="http://127.0.0.1:${TEST_PORT}" \
  TEST_EMAIL_CAPTURE_PATH="$CAPTURE_DIR/emails.jsonl" \
  PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!
for _ in $(seq 1 "${API_TEST_READY_TIMEOUT:-180}"); do
  if healthy; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "API server process exited before becoming ready" >&2
    exit 1
  fi
  sleep 1
done
if ! healthy; then
  echo "API server did not become ready at ${API_BASE}" >&2
  exit 1
fi

node tests/csrf-enforced.mjs
