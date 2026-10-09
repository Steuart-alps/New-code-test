import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { migrateLegacyPatHistory } from "../src/lib/patLegacyHistoryMigration";

/** Runs only inside the disposable fresh-schema database. */
export async function verifyLegacyPatHistoryMigration() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA pat_history_migration_fixture`);
    await tx.execute(sql`SET LOCAL search_path TO pat_history_migration_fixture`);
    await tx.execute(sql`CREATE TABLE clients(id integer PRIMARY KEY)`);
    await tx.execute(sql`CREATE TABLE sites(id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE, name text, department_id integer)`);
    await tx.execute(sql`CREATE TABLE pat_appliances(
      id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE,
      site_id integer REFERENCES sites(id) ON DELETE SET NULL, name text,
      location text, appliance_type text, asset_tag text
    )`);
    await tx.execute(sql`CREATE TABLE pat_tests(
      id integer PRIMARY KEY, client_id integer REFERENCES clients(id) ON DELETE CASCADE,
      appliance_id integer REFERENCES pat_appliances(id) ON DELETE CASCADE
    )`);
    await tx.execute(sql`INSERT INTO clients VALUES(1),(2)`);
    await tx.execute(sql`INSERT INTO sites VALUES(1,1,'Original site',7)`);
    await tx.execute(sql`INSERT INTO pat_appliances VALUES(1,1,1,'Original appliance','Old location','Other',NULL),(2,1,NULL,'Unlocated',NULL,'Other',NULL)`);
    await tx.execute(sql`INSERT INTO pat_tests VALUES(1,1,1),(2,1,2)`);
    await migrateLegacyPatHistory(tx);
    const row = (await tx.execute(sql`SELECT * FROM pat_tests WHERE id=1`)).rows[0];
    assert.equal(row.site_id_snapshot, 1);
    assert.equal(row.department_id_snapshot, 7);
    assert.equal(row.location_snapshot, "Old location");
    assert.equal(row.snapshot_source, "legacy_backfill");
    await tx.execute(sql`UPDATE pat_appliances SET location='New location', name='Renamed' WHERE id=1`);
    await migrateLegacyPatHistory(tx);
    const replayed = (await tx.execute(sql`SELECT * FROM pat_tests WHERE id=1`)).rows[0];
    assert.deepEqual(replayed, row, "Repeated migration cannot rewrite historic snapshots");
    await tx.execute(sql`INSERT INTO pat_tests(id,client_id,appliance_id) VALUES(3,1,1)`);
    const recorded = (await tx.execute(sql`SELECT * FROM pat_tests WHERE id=3`)).rows[0];
    assert.equal(recorded.location_snapshot, "New location");
    assert.equal(recorded.snapshot_source, "recorded");
    await tx.execute(sql`UPDATE pat_tests SET location_snapshot='Spoofed', site_id_snapshot=999 WHERE id=3`);
    const preserved = (await tx.execute(sql`SELECT * FROM pat_tests WHERE id=3`)).rows[0];
    assert.deepEqual(preserved, recorded, "Snapshot edits are ignored by the database guard");
    const unlocated = (await tx.execute(sql`SELECT * FROM pat_tests WHERE id=2`)).rows[0];
    assert.equal(unlocated.site_id_snapshot, null);
    assert.equal(unlocated.location_snapshot, null);
    await tx.execute(sql`
      DO $$ BEGIN
        BEGIN
          DELETE FROM pat_appliances WHERE id=1;
          RAISE EXCEPTION 'Expected appliance foreign-key protection';
        EXCEPTION WHEN foreign_key_violation THEN NULL; END;
        BEGIN
          UPDATE pat_tests SET appliance_id=2 WHERE id=1;
          RAISE EXCEPTION 'Expected reassignment protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
        BEGIN
          INSERT INTO pat_tests(id,client_id,appliance_id) VALUES(4,2,1);
          RAISE EXCEPTION 'Expected tenant-link protection';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $$
    `);
    // Retention must not obstruct authorized whole-account erasure.
    await tx.execute(sql`DELETE FROM clients WHERE id=1`);
    assert.equal((await tx.execute(sql`SELECT count(*)::int AS count FROM pat_tests`)).rows[0].count, 0);
    await tx.execute(sql`DROP SCHEMA pat_history_migration_fixture CASCADE`);
  });
  console.log("Legacy PAT migration backfill, replay, snapshot guards and tenant erasure checks passed.");
}