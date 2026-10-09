import assert from "node:assert/strict";
import { db, pool, auditContext } from "@workspace/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { auditPool } from "../../../lib/db/src/audit-context";
import { AUDITED_TABLES, migrateAuditLog } from "../src/lib/auditLogMigration";

// All fixtures and DDL live in a unique schema, never production tenant tables.
const schema = `audit_test_${process.pid}_${Date.now()}`;
const setup = await pool.connect();
await setup.query(`CREATE SCHEMA "${schema}"`);
setup.release(true);
pool.options.options = `-c search_path=${schema}`;
try {
  await db.execute(sql.raw(`
    CREATE TABLE clients(id integer PRIMARY KEY);
    INSERT INTO clients VALUES (1),(2);
    ${AUDITED_TABLES.map((table) => `
      CREATE TABLE "${table}"(id serial PRIMARY KEY, client_id integer NOT NULL,
        notes text, created_by integer, metadata jsonb, callback_url text);
    `).join("\n")}
  `));
  await migrateAuditLog();
  await migrateAuditLog(); // idempotent
  // Fault injection on a real checked-out pg connection. In Drizzle, BEGIN is
  // outside its transaction try/finally: setup cleanup belongs to the adapter.
  for (const failure of ["begin", "actor", "actor-and-rollback"] as const) {
    let releases = 0;
    let rollbackAttempts = 0;
    let destroyed = false;
    const injectedPool = new Proxy(pool, {
      get(target, key) {
        if (key !== "connect") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, property) {
              if (property === "release") return (destroy?: boolean) => {
                releases++;
                destroyed = destroy === true;
                connection.release(destroy);
              };
              if (property === "query") return async (...args: any[]) => {
                const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
                if (/^\s*begin\b/i.test(text) && failure === "begin") throw new Error("injected BEGIN failure");
                if (text.includes("set_config")) throw new Error("injected actor setup failure");
                if (/^\s*rollback\b/i.test(text)) {
                  rollbackAttempts++;
                  if (failure === "actor-and-rollback") throw new Error("injected rollback failure");
                }
                return (connection.query as any)(...args);
              };
              const value = Reflect.get(connection, property);
              return typeof value === "function" ? value.bind(connection) : value;
            },
          });
        };
      },
    });
    const adapter = auditPool(injectedPool);
    const injectedDb = drizzle(adapter);
    let callbackEntered = false;
    await assert.rejects(auditContext.run({ actorId: 555, active: true }, () =>
      injectedDb.transaction(async () => { callbackEntered = true; })));
    assert.equal(callbackEntered, false);
    assert.equal(releases, 1, `${failure}: checked-out client released exactly once`);
    assert.equal(rollbackAttempts, 1, `${failure}: rollback attempted`);
    assert.equal(destroyed, true, `${failure}: uncertain connection destroyed`);
    assert.equal(pool.waitingCount, 0);
    // An explicit caller's defensive release after setup failure is harmless.
    const client = await adapter.connect();
    await assert.rejects(client.query("BEGIN"));
    client.release();
    assert.equal(releases, 2, `${failure}: no double release after setup rejection`);
    // Subsequent ordinary and attributed transactions remain usable.
    assert.equal((await db.execute(sql`SELECT 1 AS ok`)).rows[0].ok, 1);
    await auditContext.run({ actorId: 556, active: true }, () =>
      db.transaction(async (tx) => {
        assert.equal((await tx.execute(sql`SELECT current_setting('app.audit_actor',true) actor`)).rows[0].actor, "556");
      }));
    const clean = (await db.execute(sql`SELECT nullif(current_setting('app.audit_actor',true),'') actor`)).rows[0];
    assert.equal(clean.actor, null, `${failure}: pool reuse does not inherit failed actor`);
  }
  for (const table of AUDITED_TABLES) {
    const create = await db.execute(sql.raw(`INSERT INTO "${table}"(client_id,notes,created_by)
      VALUES (1,'original',999) RETURNING id`));
    const id = create.rows[0].id;
    await auditContext.run({ actorId: 42, active: true }, async () => {
      await db.execute(sql.raw(`UPDATE "${table}" SET notes='changed' WHERE id=${id}`));
      await db.execute(sql.raw(`DELETE FROM "${table}" WHERE id=${id}`));
    });
    const events = await db.execute(sql`SELECT * FROM audit_log WHERE table_name=${table} ORDER BY id`);
    assert.deepEqual(events.rows.map((r) => r.action), ["create", "update", "delete"]);
    assert.deepEqual(events.rows.map((r) => r.changed_by), [null, 42, 42]);
    assert.deepEqual((events.rows[1].diff as any).notes, { before: "original", after: "changed" });
  }
  const baseline = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log`);
  await assert.rejects(auditContext.run({ actorId: 11, active: true }, () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO fire_safety_checks(client_id,notes) VALUES (1,'rollback')`);
      throw new Error("intentional rollback");
    })), /intentional rollback/);
  assert.equal((await db.execute(sql`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n, baseline.rows[0].n);
  await Promise.all(Array.from({ length: 24 }, (_, i) =>
    auditContext.run({ actorId: 100 + i, active: true }, async () => {
      const write = sql`INSERT INTO fire_safety_checks(client_id,notes) VALUES (1,${`actor-${100 + i}`})`;
      if (i % 2) await db.transaction(async (tx) => { await tx.execute(write); });
      else await db.execute(write);
    })));
  const concurrent = await db.execute(sql`SELECT changed_by,diff FROM audit_log WHERE diff->'notes'->>'after' LIKE 'actor-%'`);
  assert.equal(concurrent.rows.length, 24);
  for (const event of concurrent.rows) assert.equal((event.diff as any).notes.after, `actor-${event.changed_by}`);
  await assert.rejects(auditContext.run({ actorId: 777, active: true }, () =>
    db.execute(sql`INSERT INTO fire_safety_checks(client_id) VALUES (NULL)`)));
  await auditContext.run({ actorId: 888, active: false }, () =>
    db.execute(sql`INSERT INTO fire_safety_checks(client_id,notes) VALUES (1,'finished-request')`));
  assert.equal((await db.execute(sql`SELECT changed_by FROM audit_log
    WHERE diff->'notes'->>'after'='finished-request'`)).rows[0].changed_by, null);
  await db.execute(sql`INSERT INTO fire_safety_checks(client_id,notes,metadata,callback_url)
    VALUES (2,'system', '{"nested":{"token":"do-not-store","ok":true}}', 'https://example.test/?token=secret')`);
  const system = (await db.execute(sql`SELECT * FROM audit_log WHERE client_id=2`)).rows[0];
  assert.equal(system.changed_by, null);
  assert.ok(!JSON.stringify(system.diff).includes("do-not-store"));
  assert.ok(!JSON.stringify(system.diff).includes("https://"));
  const causedBy = (message: string) => (error: any) => String(error.cause?.message ?? error.message).includes(message);
  await assert.rejects(db.execute(sql`UPDATE audit_log SET changed_by=1`), causedBy("append-only"));
  await assert.rejects(db.execute(sql`DELETE FROM audit_log`), causedBy("append-only"));
  await assert.rejects(db.execute(sql`TRUNCATE audit_log`), causedBy("append-only"));
  await assert.rejects(db.execute(sql`TRUNCATE fire_safety_checks`), causedBy("append-only"));
  await assert.rejects(db.execute(sql`UPDATE fire_safety_checks SET client_id=2 WHERE client_id=1`), causedBy("cannot move"));
  // A source mutation must roll back if evidence cannot be inserted.
  await db.execute(sql`ALTER TABLE audit_log ADD CONSTRAINT test_reject CHECK (row_id < 1000000)`);
  await assert.rejects(db.execute(sql`INSERT INTO fire_safety_checks(id,client_id) VALUES (1000000,1)`));
  assert.equal((await db.execute(sql`SELECT count(*)::int n FROM fire_safety_checks WHERE id=1000000`)).rows[0].n, 0);
  console.info("Audit database tests passed: all eight CRUD triggers, rollback, concurrent actors, system actor, redaction, immutability and fail-closed capture.");
} finally {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}