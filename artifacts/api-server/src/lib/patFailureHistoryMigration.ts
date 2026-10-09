import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

/**
 * PAT failure location is inspection evidence. It is captured once, when the
 * failure is recorded, and ordinary status/resolution edits can never rewrite
 * it or move the failure to another certificate or room. A wrong location is
 * corrected by appending a reviewable row to pat_failure_location_corrections.
 *
 * Additive and replay-safe. Rows written before snapshots existed are labelled
 * by how their identity was obtained, never as verified "recorded" evidence:
 * - legacy_backfill: filled from the room's name when this migration ran.
 * - legacy_edit_recapture: had snapshots, but an edit before this migration
 *   may have recaptured them from the room's then-current name.
 * - legacy_unavailable: no room or location could be established.
 */
export async function migratePatFailureHistory(executor?: { execute(query: SQL): Promise<any> }): Promise<void> {
  if (!executor) {
    await db.transaction((tx) => migratePatFailureHistory(tx));
    return;
  }
  await executor.execute(sql`
    ALTER TABLE pat_failures
      ADD COLUMN IF NOT EXISTS location_text text,
      ADD COLUMN IF NOT EXISTS room_name_snapshot text,
      ADD COLUMN IF NOT EXISTS snapshot_source text
  `);
  // A drizzle-created base schema already has the NOT NULL default; only
  // columns added above can still be NULL, so this is a no-op on replay.
  await executor.execute(sql`
    UPDATE pat_failures f
    SET room_name_snapshot=r.name, location_text=COALESCE(f.location_text, r.name), snapshot_source='legacy_backfill'
    FROM pat_rooms r, pat_certificates c
    WHERE f.snapshot_source IS NULL AND f.room_name_snapshot IS NULL
      AND r.id=f.room_id AND r.client_id=f.client_id
      AND c.id=f.certificate_id AND c.client_id=f.client_id AND c.site_id=r.site_id
  `);
  await executor.execute(sql`
    UPDATE pat_failures SET snapshot_source='legacy_edit_recapture'
    WHERE snapshot_source IS NULL AND (room_name_snapshot IS NOT NULL OR location_text IS NOT NULL)
      AND updated_at > created_at
  `);
  await executor.execute(sql`
    UPDATE pat_failures SET snapshot_source='recorded'
    WHERE snapshot_source IS NULL AND (room_name_snapshot IS NOT NULL OR location_text IS NOT NULL)
  `);
  await executor.execute(sql`
    UPDATE pat_failures SET snapshot_source='legacy_unavailable' WHERE snapshot_source IS NULL
  `);
  await executor.execute(sql`
    ALTER TABLE pat_failures ALTER COLUMN snapshot_source SET DEFAULT 'recorded',
      ALTER COLUMN snapshot_source SET NOT NULL
  `);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS pat_failure_location_corrections (
      id serial PRIMARY KEY,
      client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      failure_id integer NOT NULL REFERENCES pat_failures(id) ON DELETE CASCADE,
      previous_location_text text,
      corrected_location_text text NOT NULL,
      reason text NOT NULL,
      corrected_by integer REFERENCES users(id) ON DELETE SET NULL,
      corrected_by_name text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_pat_failure_location_corrections_failure"
    ON pat_failure_location_corrections (client_id, failure_id, id)
  `);
  await executor.execute(sql`
    CREATE OR REPLACE FUNCTION preserve_pat_failure_identity() RETURNS trigger AS $$
    DECLARE room_name text;
    BEGIN
      IF TG_OP='UPDATE' THEN
        -- A room deletion's ON DELETE SET NULL is the only permitted link change;
        -- the retained snapshots below keep the failure's recorded location.
        IF NEW.certificate_id IS DISTINCT FROM OLD.certificate_id
          OR NEW.client_id IS DISTINCT FROM OLD.client_id
          OR (NEW.room_id IS NOT NULL AND NEW.room_id IS DISTINCT FROM OLD.room_id) THEN
          RAISE EXCEPTION 'PAT failure evidence cannot be reassigned' USING ERRCODE='23514';
        END IF;
        NEW.location_text := OLD.location_text;
        NEW.room_name_snapshot := OLD.room_name_snapshot;
        NEW.snapshot_source := OLD.snapshot_source;
        RETURN NEW;
      END IF;
      IF NEW.room_id IS NOT NULL THEN
        SELECT r.name INTO room_name
        FROM pat_rooms r JOIN pat_certificates c ON c.site_id=r.site_id AND c.client_id=r.client_id
        WHERE r.id=NEW.room_id AND c.id=NEW.certificate_id AND r.client_id=NEW.client_id
        FOR SHARE OF r, c;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'PAT failure room and certificate must belong to the same client and site' USING ERRCODE='23514';
        END IF;
      ELSE
        PERFORM 1 FROM pat_certificates c WHERE c.id=NEW.certificate_id AND c.client_id=NEW.client_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'PAT failure certificate must belong to the same client' USING ERRCODE='23514';
        END IF;
      END IF;
      NEW.location_text := COALESCE(NULLIF(btrim(NEW.location_text), ''), room_name);
      IF NEW.location_text IS NULL THEN
        RAISE EXCEPTION 'PAT failure location is required' USING ERRCODE='23514';
      END IF;
      NEW.room_name_snapshot := COALESCE(room_name, NEW.location_text);
      NEW.snapshot_source := 'recorded';
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await executor.execute(sql`DROP TRIGGER IF EXISTS preserve_pat_failure_identity ON pat_failures`);
  await executor.execute(sql`
    CREATE TRIGGER preserve_pat_failure_identity BEFORE INSERT OR UPDATE ON pat_failures
    FOR EACH ROW EXECUTE FUNCTION preserve_pat_failure_identity()
  `);
  // Corrections are append-only evidence: they are never edited after the fact.
  // Only a user deletion's ON DELETE SET NULL may clear the actor link; the
  // retained corrected_by_name still identifies who made the correction.
  await executor.execute(sql`
    CREATE OR REPLACE FUNCTION reject_pat_failure_correction_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.corrected_by IS NULL AND OLD.corrected_by IS NOT NULL
        AND (to_jsonb(NEW) - 'corrected_by') = (to_jsonb(OLD) - 'corrected_by') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'PAT failure location corrections are append-only' USING ERRCODE='23514';
    END;
    $$ LANGUAGE plpgsql
  `);
  await executor.execute(sql`DROP TRIGGER IF EXISTS reject_pat_failure_correction_update ON pat_failure_location_corrections`);
  await executor.execute(sql`
    CREATE TRIGGER reject_pat_failure_correction_update BEFORE UPDATE ON pat_failure_location_corrections
    FOR EACH ROW EXECUTE FUNCTION reject_pat_failure_correction_update()
  `);
}
