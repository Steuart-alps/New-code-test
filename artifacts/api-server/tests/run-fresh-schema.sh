#!/usr/bin/env bash
# Never uses DATABASE_URL or API_BASE from the caller; no application data touched.
set -euo pipefail
cd "$(dirname "$0")/.."
# The database is private, but API bundling and startup still compete for RAM.
source tests/api-integration-lock.sh
for binary in initdb pg_ctl psql node; do
  command -v "$binary" >/dev/null || { echo "Required test tool missing: $binary" >&2; exit 1; }
done
temp="$(mktemp -d)"
build="$(mktemp -d "$PWD/tests/.build-fresh-schema-XXXXXX")"
server_pid=""
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  pg_ctl -D "$temp/data" -m immediate stop >/dev/null 2>&1 || true
  if [ "$result" -ne 0 ]; then cat "$temp/server.log" 2>/dev/null || true; fi
  rm -rf "$temp" "$build"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
initdb -D "$temp/data" -A trust -U schema_test --no-locale >/dev/null
# Unix-socket-only Postgres is isolated by its unique private temp directory.
pg_ctl -D "$temp/data" -l "$temp/postgres.log" -o "-k $temp -c listen_addresses=''" -w start >/dev/null
psql -h "$temp" -U schema_test -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE schema_test' >/dev/null
url="postgresql://schema_test@/schema_test?host=$temp"
count="$(psql "$url" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[ "$count" = "0" ] || { echo "Disposable database is not empty" >&2; exit 1; }
: > "$temp/contractor-outbox.jsonl"
# Synthetic, test-only key: no workspace encryption key or mail credentials.
test_token_key="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
node tests/build-fresh-schema.mjs "$build"
port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
# Scrub inherited credentials: no email, Stripe, storage, or shared database access.
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test FRESH_SCHEMA_TEST=1 \
  SESSION_SECRET=disposable-schema-test-only-not-a-real-secret \
  DATABASE_URL="$url" PORT="$port" \
  CONTRACTOR_TOKEN_ENCRYPTION_KEY="$test_token_key" CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION=disposable-test TEST_EMAIL_BEHAVIOR=success \
  TEST_EMAIL_CAPTURE_PATH="$temp/system-outbox.jsonl" FIXTRACK_TEST_EMAIL_OUTBOX="$temp/contractor-outbox.jsonl" \
  node "$build/server.mjs" >"$temp/server.log" 2>&1 &
server_pid=$!
ready=0
for _ in $(seq 1 120); do
  if curl -sf -m 2 "http://127.0.0.1:$port/readyz" >/dev/null; then ready=1; break; fi
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 1
done
[ "$ready" = "1" ] || { echo "Fresh-schema API did not become ready" >&2; exit 1; }
if [ "$#" -gt 0 ]; then
  # Reuse the isolated infrastructure for focused HTTP suites. Never give the
  # suite a shared database connection or credentials for email providers.
  # SQL-backed suites receive only this disposable Unix-socket database.
  for suite in "$@"; do
    env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test FRESH_SCHEMA_TEST=1 \
      API_BASE="http://127.0.0.1:$port/api" DATABASE_URL="$url" \
      CONTRACTOR_TOKEN_ENCRYPTION_KEY="$test_token_key" CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION=disposable-test TEST_EMAIL_BEHAVIOR=success \
      TEST_EMAIL_CAPTURE_PATH="$temp/system-outbox.jsonl" FIXTRACK_TEST_EMAIL_OUTBOX="$temp/contractor-outbox.jsonl" \
      node "$suite"
  done
else
  NODE_ENV=test API_BASE="http://127.0.0.1:$port/api" node tests/fresh-schema-routes.mjs
  DATABASE_URL="$url" API_BASE="http://127.0.0.1:$port/api" node tests/module-routes.mjs
fi
if grep -Eq '42P01|42703|relation .* does not exist|column .* does not exist|Runtime migrations failed' "$temp/server.log"; then
  echo "Missing database table/column detected in API logs" >&2
  exit 1
fi
echo "Fresh-schema validation passed (runtime migrations only, including second boot)."