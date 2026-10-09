#!/usr/bin/env bash
# Self-contained runner for tests/contractor-key-preflight.mjs: a disposable
# database (never the application database) and synthetic keys only. The
# database is dropped afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

: "${DATABASE_URL:?DATABASE_URL must point at a PostgreSQL server}"
DB_NAME="ct_keypre_$$_$(date +%s)"
ADMIN_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/postgres")))' "$DATABASE_URL")"
export DATABASE_URL="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$DATABASE_URL" "$DB_NAME")"
synthetic() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
export SESSION_SECRET="$(synthetic)"
export ROTATION_OLD_KEY="$(synthetic)"
export ROTATION_NEW_KEY="$(synthetic)"
export CONTRACTOR_TOKEN_ENCRYPTION_KEY="$ROTATION_OLD_KEY"
export CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION="rot-old"
unset CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS

cleanup() { psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
node ../../lib/db/bootstrap.mjs >/dev/null
pnpm run build >/dev/null
node tests/contractor-key-preflight.mjs
