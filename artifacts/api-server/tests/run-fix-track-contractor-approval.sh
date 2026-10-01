#!/usr/bin/env bash
# Real approval routes and scheduler, private database, captured mail only.
set -euo pipefail
cd "$(dirname "$0")/.."
# Each suite owns its API as well as its database. Combining their fixture
# logins in one process would correctly hit the production IP login limit.
for suite in \
  tests/fix-track-contractor-approval.mjs \
  tests/fix-track-quote-workflow.mjs \
  tests/compliance-reminder-approval.mjs; do
  bash tests/run-fresh-schema.sh "$suite"
done