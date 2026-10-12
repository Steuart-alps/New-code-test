#!/usr/bin/env bash
# Real browser round trips for staff media uploads: real API session + CSRF +
# mandatory 2FA, real presigned upload from the browser, content validation,
# ACL finalization, reload visibility and tenant boundaries.
#
#   bash tests/run-photo-storage-roundtrip.sh                    # dedicated GCS test bucket
#   bash tests/run-photo-storage-roundtrip.sh --in-process-fake  # NOT the real round trip
#   ... --fixtrack-video   # FixTrack MP4/MOV/WebM suite instead of incident photos
#
# The default suite covers incident photos (attach, reload, delete). The
# FixTrack video suite covers attach, gallery play and seek before and after a
# reload, byte ranges, tenant boundaries and viewer refusal.
#
# Storage comes only from the PHOTO_ROUNDTRIP_* variables (see
# photo-roundtrip-config.mjs). Without them the real mode skips with a message
# (or fails when PHOTO_ROUNDTRIP_REQUIRED=1). Every run uses a disposable
# Postgres, fresh tenants and a unique private/photo-roundtrip-<hex> prefix,
# which is emptied in the exit trap. Application credentials and buckets are
# never passed to the API under test.
set -euo pipefail
cd "$(dirname "$0")/.."
api_dir="$PWD"
web_dir="$(cd ../compliance-tracker && pwd)"
db_dir="$(cd ../../lib/db && pwd)"

mode="gcs"
browser_test="photo-storage-roundtrip-browser.test.mjs"
for arg in "$@"; do
  case "$arg" in
    --in-process-fake) mode="in-process-fake" ;;
    --fixtrack-video) browser_test="fixtrack-video-roundtrip-browser.test.mjs" ;;
    *) echo "Usage: $0 [--in-process-fake] [--fixtrack-video]" >&2; exit 2 ;;
  esac
done

set +e
node tests/photo-roundtrip-config.mjs check "$mode"
status=$?
set -e
if [ "$status" = "78" ]; then exit 0; fi
[ "$status" = "0" ] || exit "$status"

source tests/api-integration-lock.sh
for binary in initdb pg_ctl psql node pnpm curl; do
  command -v "$binary" >/dev/null || { echo "Required test tool missing: $binary" >&2; exit 1; }
done
[ "$mode" = "gcs" ] || command -v openssl >/dev/null || { echo "openssl is required for the fake TLS endpoint" >&2; exit 1; }

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

temp="$(mktemp -d)"
build="$(mktemp -d "$api_dir/tests/.build-photo-roundtrip-XXXXXX")"
server_pid=""
prefix="private/photo-roundtrip-$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
bucket="$(node tests/photo-roundtrip-config.mjs bucket "$mode")"
if [ "$mode" = "gcs" ]; then
  port="$(node tests/photo-roundtrip-config.mjs web-port "$mode")"
else
  port="$(free_port)"
fi
origin="http://127.0.0.1:$port"

# Test-side storage access: only the PHOTO_ROUNDTRIP_* fixture variables.
inspector_env=(PHOTO_ROUNDTRIP_STORAGE="$mode" PHOTO_ROUNDTRIP_PREFIX="$prefix" PHOTO_ROUNDTRIP_APP_ORIGIN="$origin")
if [ "$mode" = "gcs" ]; then
  inspector_env+=(
    PHOTO_ROUNDTRIP_TEST_BUCKET="${PHOTO_ROUNDTRIP_TEST_BUCKET:-}"
    PHOTO_ROUNDTRIP_GCS_SERVICE_ACCOUNT_JSON="${PHOTO_ROUNDTRIP_GCS_SERVICE_ACCOUNT_JSON:-}"
    PHOTO_ROUNDTRIP_GCS_CREDENTIALS_FILE="${PHOTO_ROUNDTRIP_GCS_CREDENTIALS_FILE:-}"
    PHOTO_ROUNDTRIP_GCS_PROJECT_ID="${PHOTO_ROUNDTRIP_GCS_PROJECT_ID:-}"
  )
else
  upload_port="$(free_port)"
  control_port="$(free_port)"
  inspector_env+=(PHOTO_ROUNDTRIP_FAKE_CONTROL_URL="http://127.0.0.1:$control_port")
fi

cleanup() {
  local result=$?
  trap - EXIT
  if [ -n "$server_pid" ]; then
    # Remove leftovers while the fake (which lives in the API process) is still up.
    env -i PATH="$PATH" HOME="$HOME" "${inspector_env[@]}" node tests/photo-roundtrip-bucket.mjs cleanup || result=1
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  elif [ "$mode" = "gcs" ]; then
    env -i PATH="$PATH" HOME="$HOME" "${inspector_env[@]}" node tests/photo-roundtrip-bucket.mjs cleanup || result=1
  fi
  pg_ctl -D "$temp/data" -m immediate stop >/dev/null 2>&1 || true
  if [ "$result" -ne 0 ]; then tail -n 80 "$temp/server.log" 2>/dev/null || true; fi
  rm -rf "$temp" "$build"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Disposable database: base schema from lib/db (as Render's pre-deploy does),
# then the API's runtime migrations at startup.
initdb -D "$temp/data" -A trust -U photo_roundtrip --no-locale >/dev/null
pg_ctl -D "$temp/data" -l "$temp/postgres.log" -o "-k $temp -c listen_addresses=''" -w start >/dev/null
psql -h "$temp" -U photo_roundtrip -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE photo_roundtrip' >/dev/null
url="postgresql://photo_roundtrip@/photo_roundtrip?host=$temp"
(cd "$db_dir" && env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$url" node bootstrap.mjs >"$temp/bootstrap.log" 2>&1) \
  || { cat "$temp/bootstrap.log"; exit 1; }

if [ "$mode" = "gcs" ]; then
  env -i PATH="$PATH" HOME="$HOME" "${inspector_env[@]}" node tests/photo-roundtrip-bucket.mjs preflight
fi

node -e '
  const { build } = require("esbuild");
  build({
    entryPoints: ["tests/photo-roundtrip-server.ts"], outfile: process.argv[1] + "/server.mjs",
    bundle: true, platform: "node", format: "esm", logLevel: "warning",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from \"node:module\"; globalThis.require = __testRequire(import.meta.url);" },
  }).catch(error => { console.error(error); process.exit(1); });
' "$build"
# The API serves the production web build from the same origin, so the browser
# test needs no request interception or proxying.
(cd "$web_dir" && PORT="$port" BASE_PATH=/ pnpm exec vite build --config vite.config.ts --configLoader runner \
  --outDir "$temp/web" --emptyOutDir --logLevel warn >"$temp/web-build.log" 2>&1) \
  || { cat "$temp/web-build.log"; exit 1; }

server_env=(
  PATH="$PATH" HOME="$HOME" NODE_ENV=test PHOTO_ROUNDTRIP_TEST=1 ENFORCE_CSRF=1 ENFORCE_MANDATORY_2FA=1
  SESSION_SECRET="photo-roundtrip-$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  DATABASE_URL="$url" PORT="$port" WEB_DIST_DIR="$temp/web" PUBLIC_APP_URL="$origin"
  CONTRACTOR_TOKEN_ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION=disposable-test
  TEST_EMAIL_BEHAVIOR=success TEST_EMAIL_CAPTURE_PATH="$temp/system-outbox.jsonl"
  PHOTO_ROUNDTRIP_STORAGE="$mode"
  GCS_BUCKET_NAME="$bucket" GCS_PRIVATE_BUCKET="$bucket" GCS_PUBLIC_BUCKET="$bucket"
  GCS_PRIVATE_PREFIX="$prefix" GCS_PUBLIC_PREFIXES="$prefix/public"
)
if [ "$mode" = "gcs" ]; then
  server_env+=(GCS_PROJECT_ID="$(env -i PATH="$PATH" "${inspector_env[@]}" node tests/photo-roundtrip-config.mjs project-id gcs)")
  # Credentials go straight from the fixture variables into the API's
  # environment; they are never written to disk or printed.
  server_env+=(GCS_SERVICE_ACCOUNT_JSON="$(env -i PATH="$PATH" "${inspector_env[@]}" node tests/photo-roundtrip-config.mjs service-account-json gcs)")
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=storage.googleapis.com" \
    -addext "subjectAltName=DNS:storage.googleapis.com" \
    -keyout "$temp/fake-storage.key" -out "$temp/fake-storage.crt" >/dev/null 2>&1
  server_env+=(
    PHOTO_ROUNDTRIP_FAKE_CORS_ORIGIN="$origin" PHOTO_ROUNDTRIP_FAKE_UPLOAD_PORT="$upload_port"
    PHOTO_ROUNDTRIP_FAKE_CONTROL_PORT="$control_port"
    PHOTO_ROUNDTRIP_FAKE_TLS_CERT="$temp/fake-storage.crt" PHOTO_ROUNDTRIP_FAKE_TLS_KEY="$temp/fake-storage.key"
  )
fi
env -i "${server_env[@]}" node --enable-source-maps "$build/server.mjs" >"$temp/server.log" 2>&1 &
server_pid=$!
ready=0
for _ in $(seq 1 120); do
  if curl -sf -m 2 "$origin/readyz" >/dev/null; then ready=1; break; fi
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 1
done
[ "$ready" = "1" ] || { echo "Storage round-trip API did not become ready" >&2; exit 1; }

browser_env=(PATH="$PATH" HOME="$HOME" PHOTO_ROUNDTRIP_APP_URL="$origin" "${inspector_env[@]}")
[ -n "${CHROMIUM_PATH:-}" ] && browser_env+=(CHROMIUM_PATH="$CHROMIUM_PATH")
[ "$mode" = "gcs" ] || browser_env+=(PHOTO_ROUNDTRIP_FAKE_UPLOAD_PORT="$upload_port")
(cd "$web_dir" && env -i "${browser_env[@]}" node "tests/$browser_test")
