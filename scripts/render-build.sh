#!/usr/bin/env bash
# Render build: install all dependencies (dev ones are needed to build), then
# build the web app and the API server bundle that serves it.
set -euo pipefail

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(npx --yes pnpm@10.28.0)
fi

"${PNPM[@]}" install --frozen-lockfile --prod=false
"${PNPM[@]}" --filter @workspace/compliance-tracker run build
"${PNPM[@]}" --filter @workspace/api-server run build
