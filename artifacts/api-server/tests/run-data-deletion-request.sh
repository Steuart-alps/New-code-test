#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh

TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
CAPTURE="$(mktemp)"
BUILD_DIR="$(mktemp -d tests/.build-data-deletion-XXXXXX)"
cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -f "$CAPTURE"
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT
pnpm run build
NODE_ENV=test ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$TEST_PORT" ADMIN_EMAIL=privacy-test@example.test TEST_EMAIL_CAPTURE_PATH="$CAPTURE" \
  node --enable-source-maps ./dist/index.mjs &
SERVER_PID=$!
ready=0
for _ in $(seq 1 120); do
  if curl -sf "http://localhost:${TEST_PORT}/readyz" >/dev/null; then ready=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "Test server exited" >&2; exit 1; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then echo "Test server not ready" >&2; exit 1; fi
node --input-type=module -e '
  import { build } from "esbuild";
  await build({
    entryPoints: ["tests/data-deletion-request.mjs"],
    outfile: process.argv[1],
    bundle: true, platform: "node", format: "esm",
    external: ["pg-native"],
    banner: { js: "import { createRequire } from \"node:module\"; globalThis.require = createRequire(import.meta.url);" },
  });
' "$BUILD_DIR/test.mjs"
API_BASE="http://localhost:${TEST_PORT}/api" TEST_EMAIL_CAPTURE_PATH="$CAPTURE" node "$BUILD_DIR/test.mjs"