// Client data deletion erases feedback reports and their append-only review
// history for that client only. Runs only inside the disposable database:
//   bash tests/run-fresh-schema.sh tests/client-data-deletion-feedback.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The client data deletion test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-client-data-deletion-"));
let offboarding;
try {
  const output = path.join(temp, "offboarding.mjs");
  await build({
    entryPoints: [path.join(testsDir, "client-data-deletion-feedback.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  offboarding = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const count = async (table, clientId) =>
  Number((await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE client_id = ${clientId}`)).rows[0].n);

try {
  const a = await createTenant("feedback-erase");
  const b = await createTenant("feedback-keep");
  const seed = async (tenant, label) => {
    const submitted = await tenant.request("POST", "/feedback", {
      category: "bug", summary: `Report from ${label}`, details: "Fixture feedback for the data-deletion test.",
    });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
    const reviewed = await tenant.request("PATCH", `/feedback/${submitted.data.id}`, {
      expectedRevision: 0, status: "reviewing", internalNote: `Reviewing ${label}`,
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  };
  await seed(a, "A");
  await seed(b, "B");
  assert.equal(await count("feedback_reports", a.clientId), 1);
  assert.equal(await count("feedback_report_reviews", a.clientId), 1);

  // Review history stays append-only outside the report/client cascade.
  await assert.rejects(db.execute(sql`DELETE FROM feedback_report_reviews WHERE client_id = ${a.clientId}`),
    (err) => /append-only/.test(`${err?.message} ${err?.cause?.message}`), "history rows cannot be deleted on their own");

  await offboarding.deleteAllClientData(a.clientId);

  assert.equal(await count("feedback_reports", a.clientId), 0, "the client's feedback reports are erased");
  assert.equal(await count("feedback_report_reviews", a.clientId), 0, "their review history goes with them");
  assert.equal(await count("feedback_reports", b.clientId), 1, "another client's reports are untouched");
  assert.equal(await count("feedback_report_reviews", b.clientId), 1, "another client's review history is untouched");
  console.log("Client data deletion erases feedback reports and review history for that client only.");

  // Every table with a client_id column is emptied for the client, except the
  // deliberately retained evidence tables; nothing of another client changes.
  const clientTables = (await db.execute(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'client_id' AND t.table_type = 'BASE TABLE'
  `)).rows.map((row) => row.table_name);
  assert.ok(clientTables.length > 50, `expected the full schema, found ${clientTables.length} client tables`);
  const rowsLeft = async (clientId) => {
    const left = {};
    for (const table of clientTables) {
      if (offboarding.RETAINED_CLIENT_TABLES.has(table)) continue;
      const n = await count(table, clientId);
      if (n > 0) left[table] = n;
    }
    return left;
  };
  assert.deepEqual(await rowsLeft(a.clientId), {}, "no client rows remain outside the retained tables");
  const [anonymised] = (await db.execute(sql`SELECT email, name, active, password_hash FROM users WHERE id = ${a.userId}`)).rows;
  assert.equal(anonymised.email, `deleted-${a.userId}@deleted.invalid`, "the client's user is anonymised");
  assert.equal(anonymised.active, false);
  assert.equal(anonymised.password_hash, "");

  // The scheduled job: due clients are deleted in one transaction and stamped;
  // a storage failure rolls the client back untouched and fails the run.
  const c = await createTenant("scheduled-erase");
  const d = await createTenant("scheduled-fail");
  await seed(c, "C");
  await seed(d, "D");
  const bBefore = await rowsLeft(b.clientId);
  for (const tenant of [c, d]) {
    await db.execute(sql`UPDATE clients SET cancelled_at = now() - interval '13 months',
      data_deletion_scheduled_at = now() - interval '1 day' WHERE id = ${tenant.clientId}`);
  }
  const alerts = [];
  const prevAdmin = process.env.ADMIN_EMAIL;
  process.env.ADMIN_EMAIL = "ops@test.local";
  await assert.rejects(offboarding.runDataDeletionJob({
    clientIds: [c.clientId, d.clientId],
    eraseStorage: async (clientId) => {
      if (clientId === d.clientId) throw new Error("simulated storage outage");
      return { objectsDeleted: 0 };
    },
    sendEmail: async (message) => { alerts.push(message.subject); },
  }), /Data deletion failed for 1 client/, "a failed client fails the run so it is alerted");
  if (prevAdmin === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = prevAdmin;
  assert.ok(alerts.some((subject) => /failed/.test(subject)), "the failure is emailed to ADMIN_EMAIL");
  const stamped = async (clientId) => (await db.execute(sql`SELECT data_deleted_at FROM clients WHERE id = ${clientId}`)).rows[0].data_deleted_at;
  assert.ok(await stamped(c.clientId), "the successful client is stamped deleted");
  assert.deepEqual(await rowsLeft(c.clientId), {}, "and has no rows left");
  assert.equal(await stamped(d.clientId), null, "the failed client is not stamped");
  assert.equal(await count("feedback_reports", d.clientId), 1, "and its data is intact (rolled back)");
  assert.deepEqual(await rowsLeft(b.clientId), bBefore, "an unscheduled client is untouched");
  console.log("Scheduled deletion is transactional, complete, and fails loudly.");
} finally {
  await pool.end();
}
