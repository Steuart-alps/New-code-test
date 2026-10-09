import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { migratePatReplacementHistory } from "../src/lib/patReplacementHistoryMigration";

/** Runs only against the disposable fresh-schema database. */
export async function verifyPatReplacementHistoryMigration() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA pat_replacement_history_fixture`);
    await tx.execute(sql`SET LOCAL search_path TO pat_replacement_history_fixture`);
    await tx.execute(sql`CREATE TABLE clients(id integer PRIMARY KEY)`);
    await tx.execute(sql`CREATE TABLE sites(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, name text)`);
    await tx.execute(sql`CREATE TABLE pat_rooms(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, site_id integer REFERENCES sites(id) ON DELETE CASCADE, name text)`);
    // The original release: no identity snapshot.
    await tx.execute(sql`
      CREATE TABLE pat_replacements(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE,
        room_id integer NOT NULL REFERENCES pat_rooms(id) ON DELETE CASCADE, appliance_name text NOT NULL,
        replaced_on date NOT NULL, replacement_details text, notes text,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())
    `);
    await tx.execute(sql`INSERT INTO clients VALUES(1),(2)`);
    await tx.execute(sql`INSERT INTO sites VALUES(10,1,'North'),(20,1,'South'),(30,2,'Foreign')`);
    await tx.execute(sql`INSERT INTO pat_rooms VALUES(1,1,10,'Room 101'),(2,1,10,'Room 102'),(3,1,20,'South room'),(4,2,30,'Foreign room')`);
    await tx.execute(sql`INSERT INTO pat_replacements(id,client_id,room_id,appliance_name,replaced_on) VALUES(1,1,1,'Kettle','2025-01-01')`);
    await migratePatReplacementHistory(tx);
    const row = async (id: number) => (await tx.execute(sql`SELECT * FROM pat_replacements WHERE id=${id}`)).rows[0] as any;
    const backfilled = await row(1);
    assert.equal(backfilled.room_name_snapshot, "Room 101");
    assert.equal(backfilled.site_id_snapshot, 10);
    assert.equal(backfilled.site_name_snapshot, "North");
    assert.equal(backfilled.snapshot_source, "legacy_backfill");

    // Replay after a rename re-derives nothing.
    await tx.execute(sql`UPDATE pat_rooms SET name='Suite 201' WHERE id=1`);
    await tx.execute(sql`UPDATE sites SET name='North Wing' WHERE id=10`);
    await migratePatReplacementHistory(tx);
    assert.deepEqual(await row(1), backfilled);

    // New records capture identity in the insert; supplied values are ignored.
    await tx.execute(sql`INSERT INTO pat_replacements(id,client_id,room_id,appliance_name,replaced_on,room_name_snapshot,site_id_snapshot,snapshot_source) VALUES(2,1,1,'Lamp','2025-02-01','Spoofed',20,'legacy_backfill')`);
    const recorded = await row(2);
    assert.equal(recorded.room_name_snapshot, "Suite 201");
    assert.equal(recorded.site_id_snapshot, 10);
    assert.equal(recorded.site_name_snapshot, "North Wing");
    assert.equal(recorded.snapshot_source, "recorded");

    // Ordinary corrections keep the snapshot even after another rename.
    await tx.execute(sql`UPDATE pat_rooms SET name='Suite 301' WHERE id=1`);
    await tx.execute(sql`UPDATE pat_replacements SET notes='Corrected', room_name_snapshot='Changed', snapshot_source='recorded' WHERE id=1`);
    const corrected = await row(1);
    assert.equal(corrected.notes, "Corrected");
    assert.equal(corrected.room_name_snapshot, "Room 101");
    assert.equal(corrected.snapshot_source, "legacy_backfill");

    // Correcting to another room on the same site captures that room's name.
    await tx.execute(sql`UPDATE pat_replacements SET room_id=2 WHERE id=2`);
    const moved = await row(2);
    assert.equal(moved.room_name_snapshot, "Room 102");
    assert.equal(moved.snapshot_source, "corrected");

    await tx.execute(sql`
      DO $$ BEGIN
        BEGIN
          UPDATE pat_replacements SET room_id=3 WHERE id=2;
          RAISE EXCEPTION 'Expected cross-site protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          UPDATE pat_replacements SET room_id=4 WHERE id=2;
          RAISE EXCEPTION 'Expected foreign-room protection on update';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO pat_replacements(id,client_id,room_id,appliance_name,replaced_on) VALUES(3,1,4,'x','2025-01-01');
          RAISE EXCEPTION 'Expected foreign-room protection on insert';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          UPDATE pat_replacements SET client_id=2 WHERE id=2;
          RAISE EXCEPTION 'Expected client protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$
    `);

    // Authorized tenant erasure still removes everything.
    await tx.execute(sql`DELETE FROM clients WHERE id=1`);
    assert.equal((await tx.execute(sql`SELECT count(*)::int AS count FROM pat_replacements`)).rows[0].count, 0);
    await tx.execute(sql`DROP SCHEMA pat_replacement_history_fixture CASCADE`);
  });
  console.log("PAT replacement identity migration backfill, replay, snapshot, correction and boundary checks passed.");
}
