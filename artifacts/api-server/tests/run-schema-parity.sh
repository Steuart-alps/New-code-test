#!/usr/bin/env bash
# Schema parity: production's base schema comes from drizzle-kit push
# (lib/db/bootstrap.mjs) followed by the runtime migrations, while the
# fresh-schema tests build theirs from runtime migrations alone. Both must end
# with the same columns, or code written against one fails on the other (the
# SafeTrack dashboard tile read a column production never had). Builds both in
# a disposable cluster and fails on any column difference not listed below.
# Never uses DATABASE_URL from the caller.
set -euo pipefail
cd "$(dirname "$0")/.."
for binary in initdb pg_ctl psql node curl; do
  command -v "$binary" >/dev/null || { echo "Required test tool missing: $binary" >&2; exit 1; }
done
temp="$(mktemp -d)"
build="$(mktemp -d "$PWD/tests/.build-schema-parity-XXXXXX")"
server_pid=""
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  pg_ctl -D "$temp/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$temp" "$build"
  exit "$result"
}
trap cleanup EXIT
initdb -D "$temp/data" -A trust -U schema_test --no-locale >/dev/null
pg_ctl -D "$temp/data" -l "$temp/postgres.log" -o "-k $temp -c listen_addresses=''" -w start >/dev/null
node tests/build-fresh-schema.mjs "$build"

# migrate <database> <push|runtime>: build one schema and list its columns.
migrate() {
  psql -h "$temp" -U schema_test -d postgres -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $1"
  local url="postgresql://schema_test@/$1?host=$temp" port
  if [ "$2" = push ]; then
    env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$url" node ../../lib/db/bootstrap.mjs >"$temp/$1-bootstrap.log" 2>&1 \
      || { cat "$temp/$1-bootstrap.log" >&2; exit 1; }
  fi
  port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test FRESH_SCHEMA_TEST=1 DATABASE_URL="$url" PORT="$port" \
    SESSION_SECRET=disposable-schema-test-only-not-a-real-secret node "$build/server.mjs" >"$temp/$1.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 120); do
    curl -sf -m 2 "http://127.0.0.1:$port/readyz" >/dev/null && break
    kill -0 "$server_pid" 2>/dev/null || { cat "$temp/$1.log" >&2; echo "API exited ($1)" >&2; exit 1; }
    sleep 1
  done
  kill "$server_pid"; wait "$server_pid" 2>/dev/null || true; server_pid=""
  psql "$url" -Atc "SELECT table_name || '.' || column_name FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY 1" | LC_ALL=C sort >"$temp/$1.cols"
}
migrate pushed push
migrate runtime runtime
{ LC_ALL=C comm -23 "$temp/pushed.cols" "$temp/runtime.cols" | sed 's/^/push-only /'
  LC_ALL=C comm -13 "$temp/pushed.cols" "$temp/runtime.cols" | sed 's/^/runtime-only /'; } | LC_ALL=C sort >"$temp/actual"
# Known, reviewed differences. runtime-only: legacy columns from older CREATE
# TABLE text that production lacks; no code may read or write them.
# push-only: green_machine_reconciliations has no runtime table and no users.
LC_ALL=C sort >"$temp/allowed" <<'EOF'
push-only green_machine_reconciliations.added_count
push-only green_machine_reconciliations.client_id
push-only green_machine_reconciliations.deactivated_count
push-only green_machine_reconciliations.id
push-only green_machine_reconciliations.posted_at
push-only green_machine_reconciliations.posted_by
push-only green_machine_reconciliations.reactivated_count
push-only green_machine_reconciliations.reconciliation_month
push-only green_machine_reconciliations.snapshot
push-only green_machine_reconciliations.source_name
push-only green_machine_reconciliations.total_rows
push-only green_machine_reconciliations.unchanged_count
push-only green_machine_reconciliations.updated_count
runtime-only hot_tub_checks.bromine_level
runtime-only hot_tub_checks.chlorine_level
runtime-only hot_tub_checks.ph_level
runtime-only hot_tub_checks.temperature_c
runtime-only hot_tubs.capacity_litres
runtime-only hot_tubs.commissioned_date
runtime-only hot_tubs.location
runtime-only hot_tubs.model
runtime-only hot_tubs.next_service_date
runtime-only hot_tubs.notes
runtime-only hot_tubs.serial_number
runtime-only safe_risk_assessments.control_measures
runtime-only safe_risk_assessments.hazard
runtime-only safe_risk_assessments.likelihood
runtime-only safe_risk_assessments.next_review_date
runtime-only safe_risk_assessments.notes
runtime-only safe_risk_assessments.reviewed_by
runtime-only safe_risk_assessments.severity
runtime-only safe_sops.category
runtime-only safe_sops.next_review_date
runtime-only safe_sops.review_date
runtime-only safe_sops.reviewed_by
runtime-only safe_sops.status
runtime-only tree_inspections.canopy_spread_m
runtime-only tree_inspections.condition
runtime-only tree_inspections.defect_description
runtime-only tree_inspections.defects_found
runtime-only tree_inspections.height_m
runtime-only tree_inspections.inspection_date
runtime-only tree_inspections.inspector_name
runtime-only tree_inspections.next_inspection_date
runtime-only tree_inspections.recommended_works
runtime-only tree_inspections.species
runtime-only tree_inspections.urgency
EOF
if ! diff -u "$temp/allowed" "$temp/actual"; then
  echo "Schema parity failed: + lines are new differences between a drizzle-kit push database and a runtime-migrations-only one; add the column to both lib/db/src/schema and runtimeMigrations.ts (- lines: update the list above)." >&2
  exit 1
fi
echo "Schema parity passed ($(wc -l <"$temp/pushed.cols") columns after push + runtime migrations)."
