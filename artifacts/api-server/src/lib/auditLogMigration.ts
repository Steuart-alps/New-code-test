import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const AUDITED_TABLES = [
  "fire_safety_checks", "legionella_checks", "food_safety_records",
  "fix_track_issues", "safe_risk_assessments", "train_track_records",
  "doc_track_documents", "incidents", "kitchen_closed_days",
] as const;

/**
 * Every other table that holds records people create or edit. Records must be
 * auditable for 5 years, and these tables are deleted with their business at
 * the end of the retention period (lib/offboarding.ts) or by user deletes, so
 * their history has to live in audit_log. Installed after all runtime
 * migrations, because several of these tables are created late in the run.
 * app_settings is excluded: it stores the write-only resendApiKey in plain
 * key/value rows that the name-based redaction can't see.
 */
export const EXTENDED_AUDITED_TABLES = [
  "allergen_chart_signoffs", "allergen_ingredients", "allergen_item_ingredients", "allergen_items",
  "allergen_menu_items", "allergen_menus", "asbestos_records", "asbestos_register_entries",
  "bike_checks", "bike_hire_records", "bike_services", "bikes",
  "categories", "certificate_defects", "check_photos", "checklist_templates", "client_documents",
  "compliance_actions", "compliance_items", "contractor_certificates",
  "contractor_email_queue", "contractor_sign_in_sites", "contractor_sign_ins", "contractor_visit_not_needed", "contractors",
  "coshh_acknowledgements", "coshh_assessments", "coshh_checks",
  "coshh_substances", "daily_checklist_submissions", "daily_checklist_teams", "daily_checklists",
  "daily_manager_signoffs", "departments", "doc_acknowledgements",
  "fire_call_points", "fire_drill_attendance", "fix_track_email_dispatches", "fix_track_issue_activity", "fix_track_quote_submissions",
  "green_application_products", "green_applications",
  "green_defects", "green_fuel_logs", "green_hour_readings", "green_machine_not_in_use", "green_machines", "green_pre_use_checks",
  "green_products", "green_puwer_inspections", "green_service_records", "green_stock_movements",
  "hot_tub_checks", "hot_tubs", "inspection_reports",
  "kitchen_cleaning_logs", "kitchen_cleaning_tasks", "kitchen_probe_checks", "kitchen_weekly_records",
  "legionella_sentinel_outlets",
  "pat_appliances", "pat_certificate_rooms", "pat_certificates",
  "pat_equipment_template_items", "pat_equipment_templates", "pat_failures",
  "pat_replacements", "pat_rooms", "pat_tests",
  "pest_activity", "pest_visits", "photo_requirements", "pool_checks", "premises_inspections",
  "privacy_breaches", "privacy_processing_activities", "privacy_processors", "privacy_programs",
  "privacy_retention_schedules", "privacy_rights_requests",
  "room_track_checks", "room_track_rooms",
  "safe_competency_signoffs", "safe_handbook", "safe_incidents", "safe_inductions",
  "safe_sops", "safe_track_acknowledgements", "safe_training_records",
  "site_documents", "sites", "staff_roster", "staff_shift_check_ins", "staff_training_records",
  "swim_first_aid_checks", "swim_incidents", "swim_sessions", "swim_surveillance_checks",
  "task_completions", "tasks",
  "track_action_templates", "track_actions", "track_control_profiles", "track_evidence",
  "track_evidence_requirements", "track_owners",
  "tree_inspections",
] as const;

async function installAuditTriggers(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tables: readonly string[]) {
  for (const table of tables) {
    // Static identifiers only. A missing required table fails migration/startup.
    await tx.execute(sql.raw(`
      DROP TRIGGER IF EXISTS compliance_audit_log ON "${table}";
      CREATE TRIGGER compliance_audit_log AFTER INSERT OR UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION capture_compliance_audit_log();
      DROP TRIGGER IF EXISTS compliance_audit_no_truncate ON "${table}";
      CREATE TRIGGER compliance_audit_no_truncate BEFORE TRUNCATE ON "${table}"
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_mutation();
    `));
  }
}

/** Install atomically: a failed trigger install must not leave partial coverage. */
export async function migrateAuditLog() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS audit_log (
        id serial PRIMARY KEY,
        client_id integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
        table_name text NOT NULL,
        row_id integer NOT NULL,
        action text NOT NULL CHECK (action IN ('create','update','delete')),
        changed_by integer,
        changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        diff jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_tenant_module_time
        ON audit_log(client_id, table_name, changed_at DESC, id DESC);
      CREATE OR REPLACE FUNCTION audit_log_redact(value jsonb)
      RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE result jsonb; k text; v jsonb;
      BEGIN
        IF jsonb_typeof(value) = 'object' THEN
          result := '{}'::jsonb;
          FOR k,v IN SELECT * FROM jsonb_each(value) LOOP
            IF k ~* '(token|secret|password|credential|authorization|cookie|url|uri|object_path|signature|pin_hash)' THEN
              result := result || jsonb_build_object(k, CASE WHEN v = 'null'::jsonb THEN v ELSE '"[REDACTED]"'::jsonb END);
            ELSE
              result := result || jsonb_build_object(k, audit_log_redact(v));
            END IF;
          END LOOP;
          RETURN result;
        ELSIF jsonb_typeof(value) = 'array' THEN
          SELECT coalesce(jsonb_agg(audit_log_redact(e)), '[]'::jsonb) INTO result FROM jsonb_array_elements(value) e;
          RETURN result;
        ELSIF jsonb_typeof(value) = 'string' AND value::text ~* '(bearer[[:space:]]|https?://|[?&;](token|key|signature)=)' THEN
          -- Strip only the links and credentials, so the rest of a note or a
          -- stored email body stays in the history.
          RETURN to_jsonb(regexp_replace(regexp_replace(regexp_replace(value #>> '{}',
            'https?://[^[:space:]"''<>]+', '[link removed]', 'gi'),
            'bearer[[:space:]]+[^[:space:]"''<>]+', 'Bearer [REDACTED]', 'gi'),
            '([?&;](token|key|signature)=)[^&[:space:]"''<>]+', '\\1[REDACTED]', 'gi'));
        END IF;
        RETURN value;
      END;
      $$;
      CREATE OR REPLACE FUNCTION capture_compliance_audit_log()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE prior jsonb := '{}'::jsonb; current_row jsonb := '{}'::jsonb;
        changes jsonb; tenant integer; entity integer; actor_text text;
      BEGIN
        IF TG_OP <> 'INSERT' THEN prior := audit_log_redact(to_jsonb(OLD)); END IF;
        IF TG_OP <> 'DELETE' THEN current_row := audit_log_redact(to_jsonb(NEW)); END IF;
        IF TG_OP = 'UPDATE' AND OLD.client_id IS DISTINCT FROM NEW.client_id THEN
          RAISE EXCEPTION 'Audited records cannot move between tenants';
        END IF;
        IF TG_OP = 'DELETE' THEN tenant := OLD.client_id; entity := OLD.id;
        ELSE tenant := NEW.client_id; entity := NEW.id; END IF;
        -- Some audited tables have no foreign key to clients, so rows can
        -- outlive a deleted client. Their history can't reference it; skip
        -- rather than fail the write (or a start-up backfill) on audit_log's FK.
        IF NOT EXISTS (SELECT 1 FROM clients WHERE id = tenant) THEN RETURN NULL; END IF;
        SELECT coalesce(jsonb_object_agg(k, jsonb_build_object(
          'before', prior->k, 'after', current_row->k)), '{}'::jsonb)
          INTO changes
          FROM (SELECT jsonb_object_keys(prior || current_row) AS k) fields
          WHERE prior->k IS DISTINCT FROM current_row->k;
        actor_text := nullif(current_setting('app.audit_actor', true), '');
        INSERT INTO audit_log(client_id, table_name, row_id, action, changed_by, diff)
        VALUES (tenant, TG_TABLE_NAME, entity,
          CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
          actor_text::integer, changes);
        RETURN NULL;
      END;
      $$;
      CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Audit log is append-only'; END;
      $$;
      DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
      CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_mutation();
    `);
    await installAuditTriggers(tx, AUDITED_TABLES);
  });
}

/** Run after every runtime migration: needs migrateAuditLog's functions. */
export async function migrateExtendedAuditLog() {
  await db.transaction((tx) => installAuditTriggers(tx, EXTENDED_AUDITED_TABLES));
}