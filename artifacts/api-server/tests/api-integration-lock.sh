#!/usr/bin/env bash
# Serializes API integration runners which share DATABASE_URL and the generated
# dist/ directory. Each runner still uses its own API port and tenant fixtures;
# the lock prevents concurrent runtime migrations/builds from racing.
#
# Source this after changing into the API-server directory.
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required to run API integration tests safely" >&2
  exit 1
fi

_api_integration_lock_file="${API_TEST_LOCK_FILE:-${TMPDIR:-/tmp}/complytrack-api-server-integration.lock}"
exec 9>"$_api_integration_lock_file"
if ! flock -w "${API_TEST_LOCK_TIMEOUT:-1800}" 9; then
  echo "Timed out waiting for the shared API integration-test lock ($_api_integration_lock_file)" >&2
  exit 1
fi