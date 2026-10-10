#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
pnpm run build >/dev/null
NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$port" node --enable-source-maps ./dist/index.mjs >/tmp/daily-track-month-history-api.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    tail -n 30 /tmp/daily-track-month-history-api.log
    exit 1
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null
API_BASE="http://127.0.0.1:$port/api" node tests/daily-track-month-history.mjs