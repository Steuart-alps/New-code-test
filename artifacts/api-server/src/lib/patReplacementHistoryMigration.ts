import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

/**
 * A PAT replacement log entry keeps the room name and site it was recorded
 * against. Renaming the room later must not change where an old replacement
 * appears to have happened.
 *
 * Additive and replay-safe. Rows written before this migration are filled from
 * the room register as it stood at migration time and labelled
 * legacy_backfill: a best-known identity, not a verified historic one.
 *
 * Existing correction workflows remain: an ordinary edit keeps the snapshot,
 * and correcting the record to a different room of the same site captures that
 * room's name at correction time (snapshot_source 'corrected'). Moving a
 * replacement to another site or client is rejected.
 */
export async function migratePatReplacementHistory(executor?: { execute(query: SQL): Promise<any> }): Promise<void> {
  if (!executor) {
    await db.transaction((tx) => migratePatReplacementHistory(tx));
    return;
  }
  await executor.execute(sql`
    ALTER TABLE pat_replacements
      ADD COLUMN IF NOT EXISTS room_name_snapshot text,
      ADD COLUMN IF NOT EXISTS site_id_snapshot integer,
      ADD COLUMN IF NOT EXISTS site_name_snapshot text,
      ADD COLUMN IF NOT EXISTS snapshot_source text
  `);
  await executor.execute(sql`
    UPDATE pat_replacements x
    SET room_name_snapshot=r.name, site_id_snapshot=r.site_id, site_name_snapshot=s.name, snapshot_source='legacy_backfill'
    FROM pat_rooms r LEFT JOIN sites s ON s.id=r.site_id AND s.client_id=r.client_id
    WHERE x.snapshot_source IS NULL AND r.id=x.room_id AND r.client_id=x.client_id
  `);
  await executor.execute(sql`
    UPDATE pat_replacements SET snapshot_source='legacy_unavailable' WHERE snapshot_source IS NULL
  `);
  await executor.execute(sql`
    ALTER TABLE pat_replacements ALTER COLUMN snapshot_source SET DEFAULT 'recorded',
      ALTER COLUMN snapshot_source SET NOT NULL
  `);
  await executor.execute(sql`
    CREATE OR REPLACE FUNCTION preserve_pat_replacement_identity() RETURNS trigger AS $$
    DECLARE room_site integer; room_name text; site_name text;
    BEGIN
      IF TG_OP='UPDATE' AND NEW.room_id IS NOT DISTINCT FROM OLD.room_id
        AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id THEN
        NEW.room_name_snapshot := OLD.room_name_snapshot;
        NEW.site_id_snapshot := OLD.site_id_snapshot;
        NEW.site_name_snapshot := OLD.site_name_snapshot;
        NEW.snapshot_source := OLD.snapshot_source;
        RETURN NEW;
      END IF;
      IF TG_OP='UPDATE' AND NEW.client_id IS DISTINCT FROM OLD.client_id THEN
        RAISE EXCEPTION 'PAT replacement evidence cannot move to another client' USING ERRCODE='23514';
      END IF;
      SELECT r.site_id, r.name, s.name INTO room_site, room_name, site_name
      FROM pat_rooms r LEFT JOIN sites s ON s.id=r.site_id AND s.client_id=r.client_id
      WHERE r.id=NEW.room_id AND r.client_id=NEW.client_id
      FOR SHARE OF r;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PAT replacement room must belong to the same client' USING ERRCODE='23514';
      END IF;
      IF TG_OP='UPDATE' THEN
        IF OLD.site_id_snapshot IS NOT NULL AND room_site IS DISTINCT FROM OLD.site_id_snapshot THEN
          RAISE EXCEPTION 'PAT replacement evidence cannot move to another site' USING ERRCODE='23514';
        END IF;
        NEW.snapshot_source := 'corrected';
      ELSE
        NEW.snapshot_source := 'recorded';
      END IF;
      NEW.room_name_snapshot := room_name;
      NEW.site_id_snapshot := room_site;
      NEW.site_name_snapshot := site_name;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await executor.execute(sql`DROP TRIGGER IF EXISTS preserve_pat_replacement_identity ON pat_replacements`);
  await executor.execute(sql`
    CREATE TRIGGER preserve_pat_replacement_identity BEFORE INSERT OR UPDATE ON pat_replacements
    FOR EACH ROW EXECUTE FUNCTION preserve_pat_replacement_identity()
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_pat_replacements_client_site" ON pat_replacements (client_id, site_id_snapshot)
  `);
}
