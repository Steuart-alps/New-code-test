#!/usr/bin/env bash
# Run the browser against a real test-mode API with isolated login fixtures.
set -euo pipefail
cd "$(dirname "$0")/../../api-server"
source tests/api-integration-lock.sh

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
pnpm run build >/dev/null
NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$port" node --enable-source-maps ./dist/index.mjs >/tmp/viewer-department-api.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    tail -n 30 /tmp/viewer-department-api.log
    exit 1
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null
cd ../compliance-tracker
VIEWER_TEST_API="http://127.0.0.1:$port/api" node tests/viewer-department-browser.test.mjs