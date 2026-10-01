import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

/** Additive, replay-safe migration; legacy locations are best-known, not verified history. */
export async function migrateLegacyPatHistory(executor?: { execute(query: SQL): Promise<any> }): Promise<void> {
  if (!executor) {
    // Hold the ALTER TABLE lock until the backfill and trigger are both ready,
    // including when older API instances are still writing during a rollout.
    await db.transaction((tx) => migrateLegacyPatHistory(tx));
    return;
  }
  await executor.execute(sql`
    ALTER TABLE pat_tests
      ADD COLUMN IF NOT EXISTS site_id_snapshot integer,
      ADD COLUMN IF NOT EXISTS site_name_snapshot text,
      ADD COLUMN IF NOT EXISTS department_id_snapshot integer,
      ADD COLUMN IF NOT EXISTS location_snapshot text,
      ADD COLUMN IF NOT EXISTS appliance_name_snapshot text,
      ADD COLUMN IF NOT EXISTS appliance_type_snapshot text,
      ADD COLUMN IF NOT EXISTS asset_tag_snapshot text,
      ADD COLUMN IF NOT EXISTS snapshot_source text
  `);
  await executor.execute(sql`
    UPDATE pat_tests t SET
      site_id_snapshot=a.site_id, site_name_snapshot=s.name,
      department_id_snapshot=s.department_id, location_snapshot=a.location,
      appliance_name_snapshot=a.name, appliance_type_snapshot=a.appliance_type,
      asset_tag_snapshot=a.asset_tag, snapshot_source='legacy_backfill'
    FROM pat_appliances a LEFT JOIN sites s ON s.id=a.site_id AND s.client_id=a.client_id
    WHERE t.appliance_id=a.id AND t.client_id=a.client_id AND t.snapshot_source IS NULL
  `);
  await executor.execute(sql`
    UPDATE pat_tests SET snapshot_source='legacy_unavailable' WHERE snapshot_source IS NULL
  `);
  await executor.execute(sql`
    ALTER TABLE pat_tests ALTER COLUMN snapshot_source SET DEFAULT 'recorded',
      ALTER COLUMN snapshot_source SET NOT NULL
  `);
  // Change only the appliance FK. Tenant-level erasure remains a cascade.
  // NO ACTION (rather than RESTRICT) also permits a whole-tenant cascade.
  await executor.execute(sql`
    DO $$
    DECLARE fk record;
    BEGIN
      FOR fk IN SELECT conname FROM pg_constraint
        WHERE conrelid='pat_tests'::regclass AND confrelid='pat_appliances'::regclass
          AND contype='f' AND confdeltype <> 'a'
      LOOP
        EXECUTE format('ALTER TABLE pat_tests DROP CONSTRAINT %I', fk.conname);
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='pat_tests'::regclass AND confrelid='pat_appliances'::regclass AND contype='f')
      THEN
        ALTER TABLE pat_tests ADD CONSTRAINT pat_tests_appliance_history_fk
          FOREIGN KEY (appliance_id) REFERENCES pat_appliances(id) ON DELETE NO ACTION;
      END IF;
    END $$
  `);
  // Capture in the same transaction as insertion, with a parent lock so a
  // simultaneous appliance relocation cannot rewrite the captured location.
  await executor.execute(sql`
    CREATE OR REPLACE FUNCTION preserve_legacy_pat_test_history() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF NEW.appliance_id IS DISTINCT FROM OLD.appliance_id OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
          RAISE EXCEPTION 'PAT test evidence cannot be reassigned' USING ERRCODE='23514';
        END IF;
        NEW.site_id_snapshot := OLD.site_id_snapshot;
        NEW.site_name_snapshot := OLD.site_name_snapshot;
        NEW.department_id_snapshot := OLD.department_id_snapshot;
        NEW.location_snapshot := OLD.location_snapshot;
        NEW.appliance_name_snapshot := OLD.appliance_name_snapshot;
        NEW.appliance_type_snapshot := OLD.appliance_type_snapshot;
        NEW.asset_tag_snapshot := OLD.asset_tag_snapshot;
        NEW.snapshot_source := OLD.snapshot_source;
        RETURN NEW;
      END IF;
      SELECT a.site_id, s.name, s.department_id, a.location, a.name, a.appliance_type, a.asset_tag
        INTO NEW.site_id_snapshot, NEW.site_name_snapshot, NEW.department_id_snapshot,
          NEW.location_snapshot, NEW.appliance_name_snapshot, NEW.appliance_type_snapshot, NEW.asset_tag_snapshot
      FROM pat_appliances a LEFT JOIN sites s ON s.id=a.site_id AND s.client_id=a.client_id
      WHERE a.id=NEW.appliance_id AND a.client_id=NEW.client_id FOR SHARE OF a;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PAT appliance does not belong to this client' USING ERRCODE='23514';
      END IF;
      NEW.snapshot_source := 'recorded';
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await executor.execute(sql`DROP TRIGGER IF EXISTS preserve_legacy_pat_test_history ON pat_tests`);
  await executor.execute(sql`
    CREATE TRIGGER preserve_legacy_pat_test_history BEFORE INSERT OR UPDATE ON pat_tests
    FOR EACH ROW EXECUTE FUNCTION preserve_legacy_pat_test_history()
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_pat_tests_historical_site" ON pat_tests(client_id, site_id_snapshot)
  `);
}