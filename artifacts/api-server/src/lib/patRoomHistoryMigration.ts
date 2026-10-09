import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

/** Backfilled names are best-known identities, not a reconstructed rename timeline. */
export async function migratePatRoomHistory(executor?: { execute(query: SQL): Promise<any> }): Promise<void> {
  if (!executor) {
    await db.transaction((tx) => migratePatRoomHistory(tx));
    return;
  }
  await executor.execute(sql`
    ALTER TABLE pat_certificate_rooms
      ADD COLUMN IF NOT EXISTS room_name_snapshot text,
      ADD COLUMN IF NOT EXISTS snapshot_source text
  `);
  await executor.execute(sql`
    UPDATE pat_certificate_rooms cr
    SET room_name_snapshot=r.name, snapshot_source='legacy_backfill'
    FROM pat_rooms r, pat_certificates c
    WHERE cr.snapshot_source IS NULL
      AND r.id=cr.room_id AND r.client_id=cr.client_id
      AND c.id=cr.certificate_id AND c.client_id=cr.client_id AND c.site_id=r.site_id
  `);
  await executor.execute(sql`
    UPDATE pat_certificate_rooms SET snapshot_source='legacy_unavailable' WHERE snapshot_source IS NULL
  `);
  await executor.execute(sql`
    ALTER TABLE pat_certificate_rooms ALTER COLUMN snapshot_source SET DEFAULT 'recorded',
      ALTER COLUMN snapshot_source SET NOT NULL
  `);
  await executor.execute(sql`
    CREATE OR REPLACE FUNCTION preserve_pat_certificate_room_identity() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF NEW.room_id IS DISTINCT FROM OLD.room_id
          OR NEW.certificate_id IS DISTINCT FROM OLD.certificate_id
          OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
          RAISE EXCEPTION 'PAT room coverage cannot be reassigned' USING ERRCODE='23514';
        END IF;
        NEW.room_name_snapshot := OLD.room_name_snapshot;
        NEW.snapshot_source := OLD.snapshot_source;
        RETURN NEW;
      END IF;
      SELECT r.name INTO NEW.room_name_snapshot
      FROM pat_rooms r JOIN pat_certificates c ON c.site_id=r.site_id AND c.client_id=r.client_id
      WHERE r.id=NEW.room_id AND c.id=NEW.certificate_id AND r.client_id=NEW.client_id
      FOR SHARE OF r,c;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PAT room and certificate must belong to the same client and site' USING ERRCODE='23514';
      END IF;
      NEW.snapshot_source := 'recorded';
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await executor.execute(sql`DROP TRIGGER IF EXISTS preserve_pat_certificate_room_identity ON pat_certificate_rooms`);
  await executor.execute(sql`
    CREATE TRIGGER preserve_pat_certificate_room_identity BEFORE INSERT OR UPDATE ON pat_certificate_rooms
    FOR EACH ROW EXECUTE FUNCTION preserve_pat_certificate_room_identity()
  `);
}