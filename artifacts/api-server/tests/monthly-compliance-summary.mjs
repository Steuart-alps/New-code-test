import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { PgDialect } from "drizzle-orm/pg-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(tmpdir(), "monthly-compliance-"));
const entry = path.join(dir, "entry.mjs");
const bundle = path.join(dir, "job.mjs");
const dialect = new PgDialect();
const deliveries = new Map();
const batches = new Set();
let stagedDeliveries = null;
let stagedBatches = null;
const currentDeliveries = () => stagedDeliveries ?? deliveries;
const currentBatches = () => stagedBatches ?? batches;
const outbound = [];
let failForSecond = true;
let failFinalizationForFirst = false;
let expireLeases = false;

globalThis.monthlySummaryDb = {
  transaction: async fn => {
    stagedDeliveries = new Map([...deliveries].map(([k, v]) => [k, { ...v }]));
    stagedBatches = new Set(batches);
    try {
      const result = await fn({ execute: globalThis.monthlySummaryDb.execute });
      deliveries.clear();
      for (const [id, row] of stagedDeliveries) deliveries.set(id, row);
      batches.clear();
      for (const key of stagedBatches) batches.add(key);
      return result;
    } finally {
      stagedDeliveries = null;
      stagedBatches = null;
    }
  },
  execute: async query => {
    const { sql, params } = dialect.sqlToQuery(query);
    if (sql.includes("SELECT id AS client_id")) return { rows: [{ client_id: 1, client_name: "Test client" }] };
    if (sql.includes("SELECT 1 FROM monthly_compliance_batches")) {
      return { rows: currentBatches().has(`${params[0]}:${params[1]}`) ? [{ "?column?": 1 }] : [] };
    }
    if (sql.includes("INSERT INTO monthly_compliance_batches")) {
      const key = `${params[0]}:${params[1]}`;
      if (currentBatches().has(key)) return { rows: [] };
      currentBatches().add(key);
      return { rows: [{ id: 1 }] };
    }
    if (sql.includes("SELECT id, email FROM users")) return { rows: [
      { id: 10, email: "first@example.test" },
      { id: 11, email: "second@example.test" },
    ] };
    if (sql.includes("FROM monthly_compliance_deliveries") && sql.includes("ORDER BY id")) {
      return { rows: [...currentDeliveries().values()].filter(d => d.state !== "sent").map(d => ({ ...d, user_id: d.userId })) };
    }
    if (sql.includes("SELECT id, name FROM sites")) return { rows: [{ id: 3, name: "<North Site>" }] };
    if (sql.includes("COUNT(DISTINCT dc.check_date)")) return { rows: [
      { site_id: 3, site_name: "<North Site>", checklist_type: "am", submitted: 15 },
      { site_id: 3, site_name: "<North Site>", checklist_type: "pm", submitted: 25 },
    ] };
    if (sql.includes("SELECT module, site_id, COUNT(*)")) return { rows: [{ module: "FireTrack", site_id: 3, records: 7 }] };
    if (sql.includes("INSERT INTO monthly_compliance_deliveries")) {
      const [clientId, userId, monthKey, recipientEmail, subject, html, text] = params;
      if (!currentDeliveries().has(userId)) currentDeliveries().set(userId, {
        id: userId, userId, clientId, monthKey, recipient_email: recipientEmail,
        subject, html, body_text: text, state: "pending",
      });
      return { rows: [] };
    }
    if (sql.includes("UPDATE monthly_compliance_deliveries")) {
      if (sql.includes("RETURNING id")) {
        const [token, clientId, userId, monthKey] = params;
        const row = currentDeliveries().get(userId);
        if (row && row.clientId === clientId && row.monthKey === monthKey &&
          (row.state === "pending" || (row.state === "sending" && expireLeases))) {
          row.state = "sending";
          row.token = token;
          return { rows: [{ ...row }] };
        }
        return { rows: [] };
      }
      const [id, token] = params;
      const row = currentDeliveries().get(id);
      if (id === 10 && sql.includes("state = 'sent'") && failFinalizationForFirst) {
        failFinalizationForFirst = false;
        throw new Error("database unavailable after provider accepted email");
      }
      if (row?.token === token) row.state = sql.includes("state = 'sent'") ? "sent" : "pending";
      return { rows: [] };
    }
    throw new Error(`Unhandled monthly summary query: ${sql}`);
  },
};

try {
  await writeFile(entry, `export { runMonthlyComplianceSummaryJob, lastMonthRange, buildEmailHtml } from ${JSON.stringify(path.join(root, "src/lib/monthlyComplianceSummary.ts"))};`);
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "node",
    plugins: [{
      name: "job-dependencies",
      setup(b) {
        b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "test" }));
        b.onResolve({ filter: /\/email$/ }, () => ({ path: "email", namespace: "test" }));
        b.onResolve({ filter: /\/logger$/ }, () => ({ path: "logger", namespace: "test" }));
        b.onLoad({ filter: /.*/, namespace: "test" }, args => ({
          contents: args.path === "db" ? "export const db = globalThis.monthlySummaryDb;" :
            args.path === "email" ? `export const sendEmail = () => { throw Error("Unexpected live send"); };
              export const escapeHtml = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;");` :
            "export const logger = { info() {}, error() {} };",
          loader: "js",
        }));
      },
    }],
  });
  const { runMonthlyComplianceSummaryJob, lastMonthRange } = await import(pathToFileURL(bundle).href);
  assert.deepEqual(lastMonthRange(new Date("2026-03-01T08:00:00Z")), {
    from: "2026-02-01", to: "2026-02-28", label: "February 2026",
  });
  const send = async email => {
    assert.equal(deliveries.size, 2, "entire batch is committed before sending the first recipient");
    if (email.to === "second@example.test" && failForSecond) {
      failForSecond = false;
      throw new Error("provider temporarily unavailable");
    }
    outbound.push(email);
  };
  const first = await runMonthlyComplianceSummaryJob(send, new Date("2026-03-01T08:00:00Z"));
  assert.equal(first.sent, 1);
  assert.equal(first.errors, 1);
  assert.match(outbound[0].html, /&lt;North Site&gt;/);
  assert.match(outbound[0].html, /color:#b91c1c/);
  assert.match(outbound[0].text, /ATTENTION \(<70%\)/);
  assert.match(outbound[0].text, /FireTrack: 7 records/);
  const second = await runMonthlyComplianceSummaryJob(send, new Date("2026-03-02T08:00:00Z"));
  assert.equal(second.sent, 1, "a failed recipient is retried the next day");
  assert.equal(outbound.length, 2, "successful recipients are not emailed again");
  assert.notEqual(outbound[0].idempotencyKey, outbound[1].idempotencyKey);
  const third = await runMonthlyComplianceSummaryJob(send, new Date("2026-03-02T09:00:00Z"));
  assert.equal(third.sent, 0);
  assert.equal(outbound.length, 2);
  assert.equal(deliveries.get(10).state, "sent");
  assert.equal(deliveries.get(11).state, "sent");

  // Simulate an accepted provider request followed by a crash before the
  // database can mark it sent. A reclaimed lease must reuse the provider key.
  deliveries.clear();
  batches.clear();
  const acceptedKeys = new Set();
  const accepted = async email => {
    if (!acceptedKeys.has(email.idempotencyKey)) {
      outbound.push(email);
      acceptedKeys.add(email.idempotencyKey);
    }
  };
  failFinalizationForFirst = true;
  const beforeCrash = await runMonthlyComplianceSummaryJob(accepted, new Date("2026-04-01T07:00:00Z"));
  assert.equal(beforeCrash.errors, 1);
  assert.equal(deliveries.get(10).state, "sending");
  expireLeases = true;
  const afterCrash = await runMonthlyComplianceSummaryJob(accepted, new Date("2026-04-02T07:00:00Z"));
  assert.equal(afterCrash.errors, 0);
  assert.equal(deliveries.get(10).state, "sent");
  assert.equal(acceptedKeys.size, 2, "reclaim uses the original provider keys");

  // The service missed the 1st entirely. Its first run on the 3rd must
  // initialize the complete previous-month batch and deliver it once.
  deliveries.clear();
  batches.clear();
  const caughtUp = await runMonthlyComplianceSummaryJob(accepted, new Date("2026-05-03T07:00:00Z"));
  assert.equal(caughtUp.sent, 2);
  assert.equal(deliveries.size, 2);
  assert.equal(batches.has("1:2026-04"), true);
  console.log("Monthly compliance summary delivery checks passed.");
} finally {
  delete globalThis.monthlySummaryDb;
  await rm(dir, { recursive: true, force: true });
}