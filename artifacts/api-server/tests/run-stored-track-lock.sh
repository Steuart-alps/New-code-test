#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/api-integration-lock.sh
_free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 19098; }
TEST_PORT="${TEST_PORT:-$(_free_port)}"
export API_BASE="${API_BASE:-http://localhost:${TEST_PORT}/api}"
ready() { curl -sf -m 2 "${API_BASE%/api}/readyz" >/dev/null 2>&1; }
SERVER_PID=""
cleanup() { [ -z "$SERVER_PID" ] || { kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" 2>/dev/null || true; }; }
trap cleanup EXIT
if ! ready; then
  pnpm run build
  NODE_ENV=test PORT="$TEST_PORT" node --enable-source-maps ./dist/index.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 90); do ready && break; kill -0 "$SERVER_PID" 2>/dev/null || exit 1; sleep 1; done
  ready || { echo "API server did not become ready" >&2; exit 1; }
fi
# Keep the middleware's server-side lookup catalogue honest.  This is a
# read-only information_schema check against the same development database.
command -v psql >/dev/null 2>&1 || { echo "psql is required for stored-date schema checks" >&2; exit 1; }
missing_schema="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At <<'SQL'
WITH expected(table_name, column_name) AS (VALUES
 ('food_safety_records','record_date'),('fire_safety_checks','check_date'),
 ('legionella_checks','check_date'),('hot_tub_checks','check_date'),
 ('tree_inspections','check_date'),('pool_checks','check_date'),
 ('daily_checklists','check_date'),('daily_manager_signoffs','signoff_date'),
 ('incidents','incident_date'),('premises_inspections','inspection_date'),
 ('room_track_checks','check_date'),('staff_training_records','issued_at'),
  ('train_track_records','completed_date'),
 ('swim_sessions','session_date'),('swim_surveillance_checks','check_date'),
 ('swim_first_aid_checks','check_date'),('swim_incidents','incident_date'),
 ('kitchen_weekly_records','week_commencing'),('kitchen_probe_checks','check_date'),
 ('bike_hire_records','hire_date'),('bike_services','service_date'),
 ('green_pre_use_checks','check_date'),('green_service_records','service_date'),
 ('green_defects','report_date'),('green_puwer_inspections','inspection_date'),
 ('green_fuel_logs','log_date'),('pat_tests','test_date'),
 ('pat_certificates','visit_date'),('pat_replacements','replaced_on'),
 ('pat_failures','created_at'),('pest_visits','visit_date'),
 ('pest_activity','recorded_date'),('safe_training_records','completed_at'),
 ('safe_inductions','start_date'),('safe_competency_signoffs','signed_off_at'))
SELECT 'missing ' || e.table_name || '.' || e.column_name
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema='public' AND c.table_name=e.table_name AND c.column_name=e.column_name
WHERE c.column_name IS NULL;
SQL
)"
if [ -n "$missing_schema" ]; then
  printf '%s\n' "$missing_schema" >&2
  echo "stored-date schema check failed" >&2
  exit 1
fi
node tests/stored-track-lock.mjs