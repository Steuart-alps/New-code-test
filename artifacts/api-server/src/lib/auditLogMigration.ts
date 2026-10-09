import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const AUDITED_TABLES = [
  "fire_safety_checks", "legionella_checks", "food_safety_records",
  "fix_track_issues", "safe_risk_assessments", "train_track_records",
  "doc_track_documents", "incidents",
] as const;

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
        ELSIF jsonb_typeof(value) = 'string' AND value::text ~* '(bearer[[:space:]]|https?://|[?&](token|key|signature)=)' THEN
          RETURN '"[REDACTED]"'::jsonb;
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
    for (const table of AUDITED_TABLES) {
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
  });
}