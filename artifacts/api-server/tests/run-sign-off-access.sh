#!/usr/bin/env bash
# Boots the real API (tests/sign-off-access-server.ts: object store replaced by
# tenant-owned test files) and runs the public sign-off access suite against it.
# Needs DATABASE_URL and SESSION_SECRET; every fixture is a new tenant.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SESSION_SECRET:?SESSION_SECRET is required}"
build="$(mktemp -d "$PWD/tests/.build-sign-off-access-XXXXXX")"
log="$build/server.log"
server_pid=""
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [ "$result" -ne 0 ]; then tail -n 80 "$log" 2>/dev/null || true; fi
  rm -rf "$build"
  exit "$result"
}
trap cleanup EXIT
node -e '
  require("esbuild").build({
    entryPoints: ["tests/sign-off-access-server.ts"],
    outfile: process.argv[1] + "/server.mjs",
    bundle: true, platform: "node", format: "esm", logLevel: "warning",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from \"node:module\"; globalThis.require = __testRequire(import.meta.url);" },
  }).catch(() => process.exit(1));
' "$build"
port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
# The suite signs managers in with a password only; this suite is about the
# public link, not two-factor enrolment.
NODE_ENV=test SIGN_OFF_ACCESS_TEST=1 ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 PORT="$port" node --enable-source-maps "$build/server.mjs" >"$log" 2>&1 &
server_pid=$!
ready=0
for _ in $(seq 1 90); do
  if curl -sf -m 2 "http://127.0.0.1:$port/readyz" >/dev/null; then ready=1; break; fi
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 1
done
[ "$ready" = "1" ] || { echo "Sign-off test API did not become ready" >&2; exit 1; }
NODE_ENV=test API_BASE="http://127.0.0.1:$port/api" node tests/sign-off-access.mjs
