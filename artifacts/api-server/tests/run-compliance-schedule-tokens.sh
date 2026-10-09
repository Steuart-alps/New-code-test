#!/usr/bin/env bash
# Self-contained runner for tests/compliance-schedule-tokens.mjs: a disposable
# database (never the application database), synthetic keys and captured mail
# only. The test starts and restarts the API itself; the database is dropped
# afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

: "${DATABASE_URL:?DATABASE_URL must point at a PostgreSQL server}"
DB_NAME="ct_schedule_$$_$(date +%s)"
ADMIN_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/postgres")))' "$DATABASE_URL")"
export DATABASE_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$DATABASE_URL" "$DB_NAME")"
synthetic() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
export SESSION_SECRET="$(synthetic)"
export CONTRACTOR_TOKEN_ENCRYPTION_KEY="$(synthetic)"
export CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION="sched-test"
unset CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS RESEND_API_KEY STRIPE_SECRET_KEY
export PUBLIC_APP_URL="https://app.example.test"
export FIXTRACK_TEST_EMAIL_OUTBOX="$(mktemp)"
export TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"

cleanup() {
  rm -f "$FIXTRACK_TEST_EMAIL_OUTBOX"
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
node ../../lib/db/bootstrap.mjs >/dev/null
pnpm run build >/dev/null
node tests/compliance-schedule-tokens.mjs
