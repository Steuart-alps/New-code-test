#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Schema changes are applied by the api-server's runtime migrations at startup
# (see artifacts/api-server/src/lib/runtimeMigrations.ts). Do NOT run
# `drizzle-kit push` here: it is interactive (hangs with stdin closed) and has
# tried to drop live tables (e.g. the sessions table used by the session store).
