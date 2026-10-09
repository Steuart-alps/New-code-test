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
} finally {
  await pool.end();
}
