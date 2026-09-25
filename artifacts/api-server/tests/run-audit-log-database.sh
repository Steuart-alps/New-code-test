#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
OUTPUT="tests/.audit-log-database-$$.mjs"
trap 'rm -f "$OUTPUT"' EXIT
pnpm exec esbuild tests/audit-log-database.ts --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile="$OUTPUT"
node "$OUTPUT"