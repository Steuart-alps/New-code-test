#!/usr/bin/env bash
# Required-storage integration run. Never points cleanup at the application bucket.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

: "${GCS_STORAGE_TEST_BUCKET:?Set a dedicated non-production GCS_STORAGE_TEST_BUCKET before running required-storage tests}"
: "${GCS_BUCKET_NAME:?Application bucket must be configured for isolation checks}"
if [ "$GCS_STORAGE_TEST_BUCKET" = "$GCS_BUCKET_NAME" ] ||
  [ "$GCS_STORAGE_TEST_BUCKET" = "${GCS_PRIVATE_BUCKET:-}" ] ||
  [ "$GCS_STORAGE_TEST_BUCKET" = "${GCS_PUBLIC_BUCKET:-}" ]; then
  echo "Refusing to run: test bucket must be different from every application bucket" >&2
  exit 1
fi

export GCS_APPLICATION_BUCKET="$GCS_BUCKET_NAME"
export GCS_BUCKET_NAME="$GCS_STORAGE_TEST_BUCKET"
export GCS_PRIVATE_BUCKET="$GCS_STORAGE_TEST_BUCKET"
export GCS_PUBLIC_BUCKET="$GCS_STORAGE_TEST_BUCKET"
export GCS_PRIVATE_PREFIX="private/integration-$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
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