#!/usr/bin/env bash
# Boots a private test-mode API and runs the daily checklist report and
# duplicate-submit regression suite against it.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
command -v psql >/dev/null || { echo "psql is required for per-run fixture cleanup" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL is required: the private API and fixture cleanup must share one database}"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
log_dir="$(mktemp -d)"
pnpm run build >/dev/null
NODE_ENV=test PORT="$port" node --enable-source-maps ./dist/index.mjs >"$log_dir/api.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; rm -rf "$log_dir"' EXIT
for attempt in $(seq 1 "${API_TEST_READY_TIMEOUT:-180}"); do
  if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    tail -n 30 "$log_dir/api.log"
    exit 1
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null || { tail -n 30 "$log_dir/api.log"; exit 1; }
API_BASE="http://127.0.0.1:$port/api" node tests/daily-checklist-reports.mjs
