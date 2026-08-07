#!/usr/bin/env bash
# Self-sufficient runner for the sign-in rate-limiter test suite.
#
# The limiter (src/lib/loginRateLimit.ts) is pure IP/email counting and needs
# no database or booted API server. We esbuild-bundle just that module to a
# temp .mjs, then run tests/login-rate-limit.mjs against it (which boots a tiny
# in-process express app using the real middleware).
set -euo pipefail

cd "$(dirname "$0")/.."

TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

OUT="$TMPDIR/loginRateLimit.mjs"

# Bundle the TS module (and its type-only express import) to ESM.
node -e "require('esbuild').build({
  entryPoints: ['src/lib/loginRateLimit.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  outfile: '$OUT',
}).catch((e)=>{console.error(e);process.exit(1)})"

LIMITER_MODULE="$OUT" node tests/login-rate-limit.mjs
