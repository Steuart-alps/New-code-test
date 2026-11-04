#!/usr/bin/env bash
# Boots its own API with test mobile-app identifiers and mandatory 2FA enforced,
# then runs the native passkey suite against the shared DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
_free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19097; }
TEST_PORT="$(_free_port)"
export API_BASE="http://localhost:${TEST_PORT}/api"
export PUBLIC_APP_URL="http://localhost:${TEST_PORT}"
export MOBILE_IOS_TEAM_ID="TEAMID1234"
export MOBILE_IOS_BUNDLE_ID="uk.test.complytrack"
export MOBILE_ANDROID_PACKAGE="uk.test.complytrack"
export MOBILE_ANDROID_CERT_SHA256="FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C"
ready() { curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1; }
SERVER_PID=""
cleanup() { [ -z "$SERVER_PID" ] || { kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; }; }
trap cleanup EXIT
pnpm run build
NODE_ENV=test ENFORCE_MANDATORY_2FA=1 PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!
for _ in $(seq 1 45); do ready && break; kill -0 "$SERVER_PID" 2>/dev/null || exit 1; sleep 1; done
ready || { echo "API server did not become ready" >&2; exit 1; }
node tests/mobile-passkeys.mjs
