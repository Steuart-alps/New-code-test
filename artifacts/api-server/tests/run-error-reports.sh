#!/usr/bin/env bash
# Error reports (Sentry) against a fake Sentry ingest: the suite boots its own
# API instances (production without SENTRY_DSN, then test with a local DSN).
set -euo pipefail

cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
command -v psql >/dev/null || { echo "psql is required to clean up this run's fixtures" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL is required: the private API and fixture cleanup must share one database}"

pnpm run build
node tests/error-reports.mjs
