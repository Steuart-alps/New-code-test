import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Records counted by the department compliance report, with the column naming
 * the account that entered each one. Every row keeps the department that
 * account belonged to when the row was created, so a later move between
 * departments never moves past records with it.
 */
export const SUBMITTER_DEPARTMENT_TABLES = [
  ["daily_checklists", "created_by"],
  ["daily_checklist_submissions", "submitted_by_id"],
  ["fire_safety_checks", "created_by"],
  ["legionella_checks", "created_by"],
  ["hot_tub_checks", "created_by"],
  ["tree_inspections", "created_by"],
  ["premises_inspections", "created_by"],
  ["pest_visits", "created_by"],
  ["incidents", "created_by"],
  ["food_safety_records", "created_by"],
  ["fix_track_issues", "created_by"],
  ["kitchen_cleaning_logs", "created_by"],
  ["pool_checks", "created_by"],
  ["swim_sessions", "created_by"],
  ["pat_tests", "created_by"],
  ["coshh_checks", "created_by"],
] as const;

/**
 * submitter_department_source:
 *  - 'recorded': captured on insert. submitter_department_id is the author's
 *    department in this tenant at that moment, or NULL when the author had
 *    none (or was not a member of the tenant, e.g. a linked consultant).
 *  - 'not_recorded': the row existed before capture began. Its department is
 *    unknown and is never inferred from the author's current department.
 *
 * Existing rows are not rewritten: ADD COLUMN with a constant default is a
 * catalogue-only change, so they read 'not_recorded' and new rows default to
 * 'recorded'. The trigger sets both columns on insert (whatever the caller
 * sent, including bearer-authenticated mobile requests and older API
 * instances during a rollout) and keeps them on every update, including the
 * ON DELETE SET NULL that clears the author when an account is removed.
 */
export async function migrateSubmitterDepartments(): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION record_submitter_department() RETURNS trigger AS $$
    DECLARE
      author_id integer;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        NEW.submitter_department_id := OLD.submitter_department_id;
        NEW.submitter_department_source := OLD.submitter_department_source;
        RETURN NEW;
      END IF;
      author_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::integer;
      NEW.submitter_department_id := NULL;
      IF author_id IS NOT NULL THEN
        SELECT u.department_id INTO NEW.submitter_department_id
        FROM users u
        JOIN departments d ON d.id = u.department_id AND d.client_id = NEW.client_id
        WHERE u.id = author_id AND u.client_id = NEW.client_id;
      END IF;
      NEW.submitter_department_source := 'recorded';
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  const existing = await db.execute(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'submitter_department_source'
  `);
  const withColumns = new Set((existing.rows as Array<{ table_name: string }>).map((row) => row.table_name));

  for (const [table, authorColumn] of SUBMITTER_DEPARTMENT_TABLES) {
    const createTrigger = sql.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger
                       WHERE tgrelid = '"${table}"'::regclass AND tgname = 'record_submitter_department') THEN
          CREATE TRIGGER record_submitter_department BEFORE INSERT OR UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION record_submitter_department('${authorColumn}');
        END IF;
      END $$
    `);
    if (withColumns.has(table)) {
      // Created by drizzle push (an empty database) or an earlier start.
      await db.execute(createTrigger);
      continue;
    }
    // Columns, default switch and trigger commit together, so no row can be
    // written in between and look recorded without a captured department.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "submitter_department_id" integer,
          ADD COLUMN IF NOT EXISTS "submitter_department_source" text NOT NULL DEFAULT 'not_recorded'
      `));
      await tx.execute(sql.raw(`
        ALTER TABLE "${table}" ALTER COLUMN "submitter_department_source" SET DEFAULT 'recorded'
      `));
      await tx.execute(createTrigger);
    });
  }
}
