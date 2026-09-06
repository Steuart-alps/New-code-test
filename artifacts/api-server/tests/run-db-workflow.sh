#!/usr/bin/env bash
# Run a database-backed workflow test without overlapping another workflow
# that mutates shared scheduling/reminder rows.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
exec node "$@"