#!/usr/bin/env bash
# Required-storage integration run. Never points cleanup at the application bucket.
set -euo pipefail
cd "$(dirname "$0")/.."

# The dedicated bucket and its test-only service-account key come from the
# GCS_STORAGE_TEST_* variables (see storage-happy-path-fixture.mjs). The check
# refuses a bucket that any application storage variable names, including the
# /bucket/... paths in PRIVATE_OBJECT_DIR and PUBLIC_OBJECT_SEARCH_PATHS.
# Exit 78 is an intentional skip (nothing configured here): release validation
# reports it as SKIP, and STORAGE_HAPPY_PATH_REQUIRED=1 turns it into a failure.
set +e
node tests/storage-happy-path-fixture.mjs check
status=$?
set -e
[ "$status" = "0" ] || exit "$status"

# Suites run serially, only after the fixture preflight passes, and the exit
# trap empties the run prefix after a pass or a failure.
source tests/api-integration-lock.sh
: "${DATABASE_URL:?Set DATABASE_URL to a development/test database; suites purge and verify only their own fixture rows}"
: "${SESSION_SECRET:?Set SESSION_SECRET for the test API}"
APPLICATION_BUCKETS="$(node tests/storage-happy-path-fixture.mjs application-buckets)"
TEST_SERVICE_ACCOUNT_JSON="$(node tests/storage-happy-path-fixture.mjs service-account-json)"
TEST_PROJECT_ID="$(node tests/storage-happy-path-fixture.mjs project-id)"
TEST_BUCKET="$(node tests/storage-happy-path-fixture.mjs bucket)"

# Nothing from application storage reaches the test API or the fixture: no
# application key, no ambient Google credentials, no application bucket paths
# (PRIVATE_OBJECT_DIR / PUBLIC_OBJECT_SEARCH_PATHS would override the test
# bucket and prefix).
unset GCS_SERVICE_ACCOUNT_JSON GOOGLE_APPLICATION_CREDENTIALS GCS_PROJECT_ID \
  PRIVATE_OBJECT_DIR PUBLIC_OBJECT_SEARCH_PATHS GCS_APPLICATION_BUCKET \
  GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON GCS_STORAGE_TEST_CREDENTIALS_FILE
export GCS_APPLICATION_BUCKETS="$APPLICATION_BUCKETS"
export GCS_SERVICE_ACCOUNT_JSON="$TEST_SERVICE_ACCOUNT_JSON"
unset TEST_SERVICE_ACCOUNT_JSON
[ -z "$TEST_PROJECT_ID" ] || export GCS_PROJECT_ID="$TEST_PROJECT_ID"

export GCS_STORAGE_TEST_BUCKET="$TEST_BUCKET"
export GCS_BUCKET_NAME="$GCS_STORAGE_TEST_BUCKET"
export GCS_PRIVATE_BUCKET="$GCS_STORAGE_TEST_BUCKET"
export GCS_PUBLIC_BUCKET="$GCS_STORAGE_TEST_BUCKET"
export GCS_PRIVATE_PREFIX="private/integration-$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
# Public objects also land inside the run prefix, so cleanup removes them too.
export GCS_PUBLIC_PREFIXES="$GCS_PRIVATE_PREFIX/public"
export STORAGE_TEST_REQUIRE_AVAILABLE=1

SERVER_PID=""
cleanup() {
  local result=$?
  trap - EXIT
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  node tests/storage-happy-path-fixture.mjs cleanup || result=1
  exit "$result"
}
trap cleanup EXIT
node tests/storage-happy-path-fixture.mjs preflight

pnpm run build
TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export API_BASE="http://127.0.0.1:${TEST_PORT}/api"
NODE_ENV=test PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!
for _ in $(seq 1 45); do
  if curl -sf -m 2 "http://127.0.0.1:${TEST_PORT}/readyz" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "Test API exited before readiness" >&2; exit 1; }
  sleep 1
done
curl -sf -m 2 "http://127.0.0.1:${TEST_PORT}/readyz" >/dev/null

node tests/doc-track-object-acl.mjs
node tests/generic-document-object-acl.mjs
node tests/pat-export-attachments.mjs
node tests/doc-track-signoff-status.mjs