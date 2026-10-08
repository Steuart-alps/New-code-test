#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: installs workspace
# dependencies and provisions a local PostgreSQL database so typecheck and the
# DB-backed api-server tests can run (replaces the Replit postgresql-16 module).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

pnpm install --frozen-lockfile

# Local Postgres. Schema is applied by the api-server's runtime migrations at
# startup, so only the role and database are created here.
if ! pg_isready -q; then
  service postgresql start
fi
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done

su postgres -c "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'complytrack') THEN
    CREATE ROLE complytrack LOGIN SUPERUSER PASSWORD 'complytrack';
  END IF;
END
$$;
SQL
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='complytrack'\"" | grep -q 1; then
  su postgres -c "createdb -O complytrack complytrack"
fi

# Dev-only values; real secrets belong in the environment's settings.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo 'export DATABASE_URL="${DATABASE_URL:-postgresql://complytrack:complytrack@localhost:5432/complytrack}"'
    echo 'export SESSION_SECRET="${SESSION_SECRET:-local-dev-session-secret-not-for-production}"'
  } >> "$CLAUDE_ENV_FILE"
fi
