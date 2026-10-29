// Platform operators delete a test business that never paid, at once
// (Steuart, 2026-10-29). Anything paid for, under a legal hold or already
// deleted is refused; a deletion removes only that business's records, keeps
// the clients row, switches it off and leaves an append-only "test_business"
// outcome naming the operator. Only platform operators may call the route.
// Runs only inside the disposable database:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/delete-test-business.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The test business deletion test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-delete-test-business-"));
let lib;
try {
  const output = path.join(temp, "delete-test-business.mjs");
  await build({
    entryPoints: [path.join(testsDir, "delete-test-business.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const count = async (table, clientId) =>
  (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE client_id = ${clientId}`)).rows[0].n;
const clientRow = async (id) =>
  (await db.execute(sql`SELECT active, data_deleted_at FROM clients WHERE id = ${id}`)).rows[0];
const outcomes = async (id) => (await db.execute(sql`
  SELECT reason, approved_by, request_id, outcome, rows_deleted FROM client_data_deletion_outcomes
  WHERE client_id = ${id} ORDER BY id`)).rows;

// A minimal copy of the synced Stripe tables (made by the Stripe sync when a
// key is configured, as in production; this server has none).
await db.execute(sql`CREATE SCHEMA IF NOT EXISTS stripe`);
await db.execute(sql`CREATE TABLE IF NOT EXISTS stripe.subscriptions (_raw_data jsonb,
  customer text GENERATED ALWAYS AS (_raw_data->>'customer') STORED,
  status text GENERATED ALWAYS AS (_raw_data->>'status') STORED)`);
await db.execute(sql`CREATE TABLE IF NOT EXISTS stripe.invoices (_raw_data jsonb,
  customer text GENERATED ALWAYS AS (_raw_data->>'customer') STORED,
  amount_paid bigint GENERATED ALWAYS AS ((_raw_data->>'amount_paid')::bigint) STORED)`);

try {
  const test = await createTenant("test-business");
  const keeper = await createTenant("test-business-keeper");
  const paid = await createTenant("test-business-paid");
  const operatorId = keeper.userId;
  const keeperItems = await count("compliance_items", keeper.clientId);
  assert.ok(await count("compliance_items", test.clientId) > 0, "the test business has starter checks to delete");

  // Only platform operators may use the route (none are configured here).
  const denied = await test.request("POST", `/clients/${test.clientId}/delete-test-business`, { confirmName: "anything" });
  assert.equal(denied.status, 403, JSON.stringify(denied.data));

  // A never-paid business is deleted at once and recorded.
  const deleted = await lib.deleteTestBusiness(test.clientId, operatorId);
  assert.equal(deleted.status, "deleted");
  assert.ok(deleted.rowsDeleted > 0);
  const after = await clientRow(test.clientId);
  assert.notEqual(after.data_deleted_at, null, "the business is marked deleted");
  assert.equal(after.active, false, "the business is switched off");
  assert.equal(await count("compliance_items", test.clientId), 0, "its records are gone");
  assert.equal(await count("sites", test.clientId), 0);
  const owner = (await db.execute(sql`SELECT email FROM users WHERE id = ${test.userId}`)).rows[0];
  assert.ok(owner && !owner.email.startsWith("approval-test-business-"), "its people's sign-ins are anonymised");
  assert.deepEqual(await outcomes(test.clientId), [{
    reason: "test_business", approved_by: operatorId, request_id: null, outcome: "completed", rows_deleted: deleted.rowsDeleted,
  }]);
  assert.equal(await count("compliance_items", keeper.clientId), keeperItems, "other businesses are untouched");
  assert.equal(await clientRow(keeper.clientId).then((row) => row.data_deleted_at), null);

  // Deleting it again is refused, and nothing more is recorded.
  assert.equal((await lib.deleteTestBusiness(test.clientId, operatorId)).status, "refused");
  assert.equal((await outcomes(test.clientId)).length, 1);
  assert.equal((await lib.deleteTestBusiness(999999, operatorId)).status, "not_found");

  // Anything paid for is refused, each reason on its own.
  const P = paid.clientId;
  const itemsBefore = await count("compliance_items", P);
  const refusedFor = async (label, setUp, undo) => {
    await setUp();
    assert.equal((await lib.deleteTestBusiness(P, operatorId)).status, "refused", label);
    assert.equal(await count("compliance_items", P), itemsBefore, `${label}: nothing deleted`);
    await undo();
  };
  await refusedFor("a subscription id",
    () => db.execute(sql`UPDATE clients SET stripe_subscription_id = 'sub_paid_test' WHERE id = ${P}`),
    () => db.execute(sql`UPDATE clients SET stripe_subscription_id = NULL WHERE id = ${P}`));
  await db.execute(sql`UPDATE clients SET stripe_customer_id = 'cus_paid_test' WHERE id = ${P}`);
  await refusedFor("a cancelled Stripe subscription",
    () => db.execute(sql`INSERT INTO stripe.subscriptions (_raw_data) VALUES (${JSON.stringify({ id: "sub_cancelled_test", customer: "cus_paid_test", status: "canceled" })}::jsonb)`),
    () => db.execute(sql`DELETE FROM stripe.subscriptions WHERE _raw_data->>'id' = 'sub_cancelled_test'`));
  await refusedFor("a paid invoice",
    () => db.execute(sql`INSERT INTO stripe.invoices (_raw_data) VALUES (${JSON.stringify({ id: "in_paid_test", customer: "cus_paid_test", status: "paid", amount_paid: 600 })}::jsonb)`),
    () => db.execute(sql`DELETE FROM stripe.invoices WHERE _raw_data->>'id' = 'in_paid_test'`));
  await refusedFor("an AI top-up",
    () => db.execute(sql`INSERT INTO ai_top_ups (client_id, request_id, amount_pence, allowance_pence, status) VALUES (${P}, 'topup-test', 600, 400, 'paid')`),
    () => db.execute(sql`DELETE FROM ai_top_ups WHERE client_id = ${P}`));
  await refusedFor("a legal hold",
    () => db.execute(sql`INSERT INTO privacy_retention_schedules
      (client_id, record_category, scope_description, retention_period, retention_trigger, justification, legal_hold_active)
      VALUES (${P}, 'Incidents', 'All incident records', '3 years', 'Incident date', 'Claim pending', true)`),
    () => db.execute(sql`DELETE FROM privacy_retention_schedules WHERE client_id = ${P}`));
  // A £0 invoice is not a payment: with every refusal undone it is deleted.
  await db.execute(sql`INSERT INTO stripe.invoices (_raw_data) VALUES (${JSON.stringify({ id: "in_zero_test", customer: "cus_paid_test", status: "paid", amount_paid: 0 })}::jsonb)`);
  assert.equal((await lib.deleteTestBusiness(P, operatorId)).status, "deleted");

  // Deleted businesses leave a consultant's Clients list and Portfolio.
  await db.execute(sql`UPDATE users SET role = 'consultant' WHERE id = ${keeper.userId}`);
  await db.execute(sql`INSERT INTO consultant_clients (user_id, client_id)
    VALUES (${keeper.userId}, ${test.clientId}), (${keeper.userId}, ${P}) ON CONFLICT DO NOTHING`);
  const listed = await keeper.request("GET", "/clients");
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.deepEqual(listed.data.map((c) => c.id), [keeper.clientId], "only the business that still has data is listed");
  const portfolio = await keeper.request("GET", "/portfolio");
  assert.equal(portfolio.status, 200, JSON.stringify(portfolio.data));
  assert.deepEqual(portfolio.data.businesses.map((b) => b.id), [keeper.clientId]);
  console.log("Test business deletion: never-paid businesses go at once and are recorded; paid, held or deleted ones are refused.");
} finally {
  await pool.end();
}
