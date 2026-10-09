import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { migratePatRoomHistory } from "../src/lib/patRoomHistoryMigration";

/** Runs only against the disposable fresh-schema database. */
export async function verifyPatRoomHistoryMigration() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA pat_room_history_fixture`);
    await tx.execute(sql`SET LOCAL search_path TO pat_room_history_fixture`);
    await tx.execute(sql`CREATE TABLE clients(id integer PRIMARY KEY)`);
    await tx.execute(sql`CREATE TABLE pat_rooms(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, site_id integer, name text)`);
    await tx.execute(sql`CREATE TABLE pat_certificates(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, site_id integer)`);
    await tx.execute(sql`CREATE TABLE pat_certificate_rooms(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, room_id integer REFERENCES pat_rooms(id) ON DELETE CASCADE, certificate_id integer REFERENCES pat_certificates(id) ON DELETE CASCADE)`);
    await tx.execute(sql`INSERT INTO clients VALUES(1),(2)`);
    await tx.execute(sql`INSERT INTO pat_rooms VALUES(1,1,10,'Room 101'),(2,1,20,'Other site'),(3,2,10,'Other client')`);
    await tx.execute(sql`INSERT INTO pat_certificates VALUES(1,1,10),(2,1,20),(3,2,10)`);
    await tx.execute(sql`INSERT INTO pat_certificate_rooms VALUES(1,1,1,1),(2,1,2,1)`);
    await migratePatRoomHistory(tx);
    const original = (await tx.execute(sql`SELECT * FROM pat_certificate_rooms WHERE id=1`)).rows[0];
    assert.equal(original.room_name_snapshot, "Room 101");
    assert.equal(original.snapshot_source, "legacy_backfill");
    assert.equal((await tx.execute(sql`SELECT snapshot_source FROM pat_certificate_rooms WHERE id=2`)).rows[0].snapshot_source, "legacy_unavailable");
    await tx.execute(sql`UPDATE pat_rooms SET name='Suite 201' WHERE id=1`);
    await migratePatRoomHistory(tx);
    assert.deepEqual((await tx.execute(sql`SELECT * FROM pat_certificate_rooms WHERE id=1`)).rows[0], original);
    await tx.execute(sql`INSERT INTO pat_certificate_rooms VALUES(3,1,1,1,'Spoofed','legacy_backfill')`);
    const recorded = (await tx.execute(sql`SELECT * FROM pat_certificate_rooms WHERE id=3`)).rows[0];
    assert.equal(recorded.room_name_snapshot, "Suite 201");
    assert.equal(recorded.snapshot_source, "recorded");
    await tx.execute(sql`UPDATE pat_certificate_rooms SET room_name_snapshot='Changed',snapshot_source='legacy_backfill' WHERE id=3`);
    assert.deepEqual((await tx.execute(sql`SELECT * FROM pat_certificate_rooms WHERE id=3`)).rows[0], recorded);
    await tx.execute(sql`
      DO $$ BEGIN
        BEGIN
          INSERT INTO pat_certificate_rooms(id,client_id,room_id,certificate_id) VALUES(4,1,2,1);
          RAISE EXCEPTION 'Expected cross-site protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO pat_certificate_rooms(id,client_id,room_id,certificate_id) VALUES(4,1,3,1);
          RAISE EXCEPTION 'Expected foreign-room protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO pat_certificate_rooms(id,client_id,room_id,certificate_id) VALUES(4,1,1,3);
          RAISE EXCEPTION 'Expected foreign-certificate protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          UPDATE pat_certificate_rooms SET room_id=2 WHERE id=3;
          RAISE EXCEPTION 'Expected immutable coverage protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$
    `);
    await tx.execute(sql`DELETE FROM clients WHERE id=1`);
    assert.equal((await tx.execute(sql`SELECT count(*)::int AS count FROM pat_certificate_rooms`)).rows[0].count, 0);
    await tx.execute(sql`DROP SCHEMA pat_room_history_fixture CASCADE`);
  });
  console.log("PAT room identity migration backfill, replay, snapshot and boundary checks passed.");
}