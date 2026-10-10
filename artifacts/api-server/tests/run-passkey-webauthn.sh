#!/usr/bin/env bash
# Self-contained runner for tests/passkey-webauthn.mjs: a disposable database
# (never the application database) and a synthetic session secret. The API is
# booted twice: first with the production mandatory-2FA policy, then with the
# enrolment guard off (password-only test login allowed) so the passkey
# route's own removal rule is reachable.
# The database is dropped afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL must point at a PostgreSQL server}"
DB_NAME="ct_passkey_$$_$(date +%s)"
ADMIN_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/postgres")))' "$DATABASE_URL")"
export DATABASE_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$DATABASE_URL" "$DB_NAME")"
export SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
unset RESEND_API_KEY STRIPE_SECRET_KEY PASSKEY_RP_ID PASSKEY_ORIGIN ENFORCE_CSRF
export PUBLIC_APP_URL="https://app.example.test"

SERVER_PID=""
SERVER_LOG="$(mktemp)"
stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
cleanup() {
  stop_server
  rm -f "$SERVER_LOG"
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_server() {
  local enforce="$1" allow_password_only="$2"
  local port
  port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
  export API_BASE="http://127.0.0.1:${port}/api"
  NODE_ENV=test ENFORCE_MANDATORY_2FA="$enforce" ALLOW_PASSWORD_ONLY_TEST_LOGIN="$allow_password_only" PORT="$port" node --enable-source-maps ./dist/index.mjs >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 "${API_TEST_READY_TIMEOUT:-180}"); do
    curl -sf -m 2 "http://127.0.0.1:${port}/readyz" >/dev/null 2>&1 && return 0
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      cat "$SERVER_LOG" >&2
      echo "API server exited before becoming ready" >&2
      exit 1
    fi
    sleep 1
  done
  cat "$SERVER_LOG" >&2
  echo "API server did not become ready" >&2
  exit 1
}

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
node ../../lib/db/bootstrap.mjs >/dev/null
pnpm run build >/dev/null

# Run both passes even if the first fails, so one failure cannot hide another.
status=0
start_server 1 0
PASSKEY_TEST_MODE=enforced node tests/passkey-webauthn.mjs || status=1
stop_server

start_server 0 1
PASSKEY_TEST_MODE=legacy node tests/passkey-webauthn.mjs || status=1
exit "$status"
