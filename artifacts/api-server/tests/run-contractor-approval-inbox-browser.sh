#!/usr/bin/env bash
# Approval-inbox browser suite on the fresh-schema harness, with the browser
# policy (PUBLIC_APP_URL = the private API's own origin, for CORS) enabled.
set -euo pipefail
cd "$(dirname "$0")/.."
FRESH_SCHEMA_BROWSER_POLICY=1 exec bash tests/run-fresh-schema.sh ../compliance-tracker/tests/contractor-approval-inbox-browser.test.mjs
