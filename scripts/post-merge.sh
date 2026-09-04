#!/bin/bash
set -e

# pnpm keeps the lockfile used for the current installation here. Most task
# merges do not change dependencies, so avoid taking pnpm's workspace install
# lock while the development workflows are already running.
if [ ! -f node_modules/.pnpm/lock.yaml ] || \
   ! cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; then
  pnpm install --frozen-lockfile --offline
else
  echo "Dependencies already match pnpm-lock.yaml; skipping install."
fi

# Schema changes are applied by the api-server's runtime migrations at startup
# (see artifacts/api-server/src/lib/runtimeMigrations.ts). Do NOT run
# `drizzle-kit push` here: it is interactive (hangs with stdin closed) and has
# tried to drop live tables (e.g. the sessions table used by the session store).
