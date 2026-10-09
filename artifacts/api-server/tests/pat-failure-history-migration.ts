import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { migratePatFailureHistory } from "../src/lib/patFailureHistoryMigration";

/** Runs only against the disposable fresh-schema database. */
export async function verifyPatFailureHistoryMigration() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA pat_failure_history_fixture`);
    await tx.execute(sql`SET LOCAL search_path TO pat_failure_history_fixture`);
    await tx.execute(sql`CREATE TABLE clients(id integer PRIMARY KEY)`);
    await tx.execute(sql`CREATE TABLE users(id integer PRIMARY KEY)`);
    await tx.execute(sql`CREATE TABLE pat_rooms(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, site_id integer, name text)`);
    await tx.execute(sql`CREATE TABLE pat_certificates(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, site_id integer)`);
    // The original release: no snapshot columns at all.
    await tx.execute(sql`
      CREATE TABLE pat_failures(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE,
        certificate_id integer REFERENCES pat_certificates(id) ON DELETE CASCADE,
        room_id integer REFERENCES pat_rooms(id) ON DELETE SET NULL, appliance_name text NOT NULL,
        action_taken text, resolution text, resolved_date date,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())
    `);
    await tx.execute(sql`INSERT INTO clients VALUES(1),(2)`);
    await tx.execute(sql`INSERT INTO users VALUES(7)`);
    await tx.execute(sql`INSERT INTO pat_rooms VALUES(1,1,10,'Room 101'),(2,1,20,'Other site'),(3,2,10,'Other client')`);
    await tx.execute(sql`INSERT INTO pat_certificates VALUES(1,1,10),(2,1,20),(3,2,10)`);
    await tx.execute(sql`INSERT INTO pat_failures(id,client_id,certificate_id,room_id,appliance_name) VALUES(1,1,1,1,'Kettle'),(2,1,1,NULL,'Lamp'),(3,1,1,2,'Heater')`);
    // A later release added snapshot columns that edits used to recapture.
    await tx.execute(sql`ALTER TABLE pat_failures ADD COLUMN location_text text, ADD COLUMN room_name_snapshot text`);
    await tx.execute(sql`
      INSERT INTO pat_failures(id,client_id,certificate_id,room_id,location_text,room_name_snapshot,appliance_name,created_at,updated_at)
      VALUES (4,1,1,1,'Room 101','Room 101','Fan','2025-01-01','2025-01-01'),
             (5,1,1,1,'Room 101','Renamed later','Toaster','2025-01-01','2025-02-01')
    `);
    await migratePatFailureHistory(tx);
    const source = async (id: number) => (await tx.execute(sql`SELECT * FROM pat_failures WHERE id=${id}`)).rows[0] as any;
    const backfilled = await source(1);
    assert.equal(backfilled.room_name_snapshot, "Room 101");
    assert.equal(backfilled.location_text, "Room 101");
    assert.equal(backfilled.snapshot_source, "legacy_backfill");
    assert.equal((await source(2)).snapshot_source, "legacy_unavailable");
    assert.equal((await source(3)).snapshot_source, "legacy_unavailable", "a cross-site legacy link is not presented as known");
    assert.equal((await source(4)).snapshot_source, "recorded");
    assert.equal((await source(5)).snapshot_source, "legacy_edit_recapture");

    // Replay does not re-derive anything after a rename.
    await tx.execute(sql`UPDATE pat_rooms SET name='Suite 201' WHERE id=1`);
    await migratePatFailureHistory(tx);
    assert.deepEqual(await source(1), backfilled);

    // New rows capture the current room name; supplied provenance is ignored.
    await tx.execute(sql`INSERT INTO pat_failures(id,client_id,certificate_id,room_id,appliance_name,room_name_snapshot,snapshot_source) VALUES(6,1,1,1,'Iron','Spoofed','legacy_backfill')`);
    const recorded = await source(6);
    assert.equal(recorded.room_name_snapshot, "Suite 201");
    assert.equal(recorded.location_text, "Suite 201");
    assert.equal(recorded.snapshot_source, "recorded");
    await tx.execute(sql`INSERT INTO pat_failures(id,client_id,certificate_id,room_id,location_text,appliance_name) VALUES(7,1,1,NULL,' Plant room ','Pump')`);
    assert.equal((await source(7)).location_text, "Plant room");

    // Ordinary edits cannot rewrite the snapshot.
    await tx.execute(sql`UPDATE pat_rooms SET name='Suite 301' WHERE id=1`);
    await tx.execute(sql`UPDATE pat_failures SET resolved_date='2025-03-01', location_text='Changed', room_name_snapshot='Changed', snapshot_source='legacy_backfill' WHERE id=6`);
    const resolved = await source(6);
    assert.equal(resolved.location_text, "Suite 201");
    assert.equal(resolved.room_name_snapshot, "Suite 201");
    assert.equal(resolved.snapshot_source, "recorded");
    assert.notEqual(resolved.resolved_date, null, "the resolution edit itself is kept");

    await tx.execute(sql`
      DO $$ BEGIN
        BEGIN
          INSERT INTO pat_failures(id,client_id,certificate_id,room_id,appliance_name) VALUES(8,1,1,2,'x');
          RAISE EXCEPTION 'Expected cross-site protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO pat_failures(id,client_id,certificate_id,room_id,appliance_name) VALUES(8,1,1,3,'x');
          RAISE EXCEPTION 'Expected foreign-room protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO pat_failures(id,client_id,certificate_id,room_id,location_text,appliance_name) VALUES(8,1,3,NULL,'Hall','x');
          RAISE EXCEPTION 'Expected foreign-certificate protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO pat_failures(id,client_id,certificate_id,room_id,appliance_name) VALUES(8,1,1,NULL,'x');
          RAISE EXCEPTION 'Expected location requirement';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          UPDATE pat_failures SET certificate_id=2 WHERE id=6;
          RAISE EXCEPTION 'Expected certificate reassignment protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          UPDATE pat_failures SET room_id=2 WHERE id=6;
          RAISE EXCEPTION 'Expected room reassignment protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$
    `);

    // Corrections are append-only; only a user deletion may clear the actor link.
    await tx.execute(sql`INSERT INTO pat_failure_location_corrections(client_id,failure_id,previous_location_text,corrected_location_text,reason,corrected_by,corrected_by_name) VALUES(1,6,'Suite 201','Suite 201 annex','Original sheet',7,'Admin')`);
    await tx.execute(sql`
      DO $$ BEGIN
        BEGIN
          UPDATE pat_failure_location_corrections SET corrected_location_text='Rewritten';
          RAISE EXCEPTION 'Expected append-only corrections';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$
    `);
    await tx.execute(sql`DELETE FROM users WHERE id=7`);
    const correction = (await tx.execute(sql`SELECT * FROM pat_failure_location_corrections`)).rows[0] as any;
    assert.equal(correction.corrected_by, null);
    assert.equal(correction.corrected_by_name, "Admin");

    // A room deletion's SET NULL keeps the snapshot; tenant erasure cascades.
    await tx.execute(sql`DELETE FROM pat_rooms WHERE id=1`);
    assert.equal((await source(6)).room_id, null);
    assert.equal((await source(6)).location_text, "Suite 201");
    await tx.execute(sql`DELETE FROM clients WHERE id=1`);
    assert.equal((await tx.execute(sql`SELECT count(*)::int AS count FROM pat_failures`)).rows[0].count, 0);
    assert.equal((await tx.execute(sql`SELECT count(*)::int AS count FROM pat_failure_location_corrections`)).rows[0].count, 0);
    await tx.execute(sql`DROP SCHEMA pat_failure_history_fixture CASCADE`);
  });
  console.log("PAT failure location migration backfill, replay, snapshot, correction and boundary checks passed.");
}
