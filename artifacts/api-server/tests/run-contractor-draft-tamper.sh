#!/usr/bin/env bash
# Self-contained runner for tests/contractor-draft-tamper.mjs.
#
# Creates a disposable database (never the application database), synthetic
# encryption keys and a captured mail outbox, boots a private API server
# against them, runs the tests, then drops the database.
#
# Needs DATABASE_URL pointing at a PostgreSQL server where this role may
# create databases; only its host and credentials are used.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

: "${DATABASE_URL:?DATABASE_URL must point at a PostgreSQL server}"
DB_NAME="ct_tamper_$$_$(date +%s)"
ADMIN_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/postgres")))' "$DATABASE_URL")"
TEST_DB_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$DATABASE_URL" "$DB_NAME")"
synthetic() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
_free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'; }

export DATABASE_URL="$TEST_DB_URL"
export SESSION_SECRET="$(synthetic)"
export CONTRACTOR_TOKEN_ENCRYPTION_KEY="$(synthetic)"
export CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION="tamper-current"
export CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS="{\"tamper-previous\":\"$(synthetic)\"}"
unset RESEND_API_KEY STRIPE_SECRET_KEY
TEST_PORT="$(_free_port)"
export API_BASE="http://localhost:${TEST_PORT}/api"
export FIXTRACK_TEST_EMAIL_OUTBOX="$(mktemp)"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$FIXTRACK_TEST_EMAIL_OUTBOX"
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
node ../../lib/db/bootstrap.mjs >/dev/null
pnpm run build >/dev/null
NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs > "${TMPDIR:-/tmp}/${DB_NAME}.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 90); do
  if curl -s -m 2 "${API_BASE%/api}/readyz" 2>/dev/null | grep -qv '"starting"'; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "API server exited early" >&2; cat "${TMPDIR:-/tmp}/${DB_NAME}.log" >&2; exit 1; fi
  sleep 1
done

node tests/contractor-draft-tamper.mjs
