// Periodic storage add-on price audit: alert once per finding, re-alert a
// changed finding, report recovery once, survive restarts, retry a failed
// email, ignore an unreadable Stripe price and stay read-only.
// Runs only inside the disposable fresh-schema database with captured email:
//   bash tests/run-fresh-schema.sh tests/storage-price-audit.mjs
import assert from "node:assert/strict";
import test, { after } from "node:test";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")
    || !process.env.TEST_EMAIL_CAPTURE_PATH) {
  throw new Error("The storage price audit test requires the disposable database and captured email harness.");
}
const outbox = process.env.TEST_EMAIL_CAPTURE_PATH;
process.env.ADMIN_EMAIL = "operators@test.local";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-storage-price-audit-"));
let lib;
try {
  const output = path.join(temp, "runtime.mjs");
  await build({
    entryPoints: [path.join(testsDir, "storage-price-audit.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}
const { db, sql, pool, evaluateStorageAddonPrice, runStoragePriceAudit, runScheduledStoragePriceAudit, STORAGE_PRICE_AUDIT_KEY } = lib;
after(() => pool.end());

const GBP = { STORAGE_USD_EXCHANGE_RATE: "0.76" };
const price = (unit_amount) => ({ id: "price_storage", active: true, type: "recurring", currency: "gbp", unit_amount, recurring: { interval: "month" } });
const checked = (unitAmount, env = GBP) => async () => evaluateStorageAddonPrice(price(unitAmount), env);
const notConfigured = async () => ({ status: "not_configured", message: "unset" });
const unreadable = async () => ({ status: "unavailable", message: "Stripe down" });
const mail = async () => (await readFile(outbox, "utf8").catch(() => ""))
  .split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .filter((entry) => entry.subject.includes("Storage add-on price"));
const state = async () => (await db.execute(sql`SELECT * FROM service_price_audit_state WHERE audit_key = ${STORAGE_PRICE_AUDIT_KEY}`)).rows;
async function reset() {
  await db.execute(sql`DELETE FROM service_price_audit_state`);
  const kept = (await readFile(outbox, "utf8").catch(() => "")).split("\n").filter(Boolean)
    .filter((line) => !JSON.parse(line).subject.includes("Storage add-on price"));
  await writeFile(outbox, kept.map((line) => `${line}\n`).join(""));
}

test("the scheduled audit waits until this process has verified Stripe", async () => {
  await reset();
  await runScheduledStoragePriceAudit();
  assert.deepEqual(await state(), []);
  assert.deepEqual(await mail(), []);
});

test("alerts once per finding, re-alerts a change and reports recovery once", async () => {
  await reset();
  let now = new Date("2026-10-15T09:35:00Z");
  const run = (check, extra = {}) => runStoragePriceAudit({ check, now: () => now, ...extra });

  assert.equal((await run(checked(10))).status, "healthy");
  assert.equal((await run(notConfigured)).status, "healthy", "an add-on that is not offered is not an incident");
  assert.equal((await mail()).length, 0);

  // The provider rate rises: 10p no longer covers cost plus margin.
  const risen = { ...GBP, STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0.11" };
  const opened = await run(checked(10, risen));
  assert.equal(opened.status, "alert");
  assert.equal(opened.delivered, "emailed");
  let sent = await mail();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "operators@test.local");
  assert.equal(sent[0].subject, "[ComplyTrack] Storage add-on price no longer covers costs: purchases paused");
  assert.match(sent[0].text, /£0\.10 per GiB-month no longer covers the provider rate plus margin \(£0\.11\)/);
  assert.match(sent[0].text, /0\.11 USD provider rate × \(1 \+ 20% margin\) × 0\.76 GBP\/USD = 10\.032, rounded up to 11 pence/);
  assert.match(sent[0].text, /Existing storage subscriptions are unchanged/);

  // Same finding later, and after a restart (state is in the database): quiet.
  now = new Date("2026-10-15T10:35:00Z");
  assert.equal((await run(checked(10, risen))).status, "ongoing");
  assert.equal((await mail()).length, 1);
  const [row] = await state();
  assert.equal(new Date(row.incident_opened_at).toISOString(), "2026-10-15T09:35:00.000Z");
  assert.equal(row.incident_issues.costUnitAmount, 11);

  // Stripe unreadable: neither recovery nor a new incident.
  assert.equal((await run(unreadable)).status, "unavailable");
  assert.equal((await state())[0].notified_fingerprint, row.notified_fingerprint);

  // Someone points the add-on at a wrong replacement price: a changed finding.
  const changed = await run(checked(9, risen));
  assert.equal(changed.status, "alert");
  sent = await mail();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /is not the £1 per 10 GiB storage price: price_not_storage_rate/);

  // The rate setting is corrected and the storage price is back.
  const recovered = await run(checked(10));
  assert.equal(recovered.status, "recovered");
  sent = await mail();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].subject, "[ComplyTrack] Storage add-on price back in line");
  assert.equal((await state())[0].incident_fingerprint, null);
  assert.equal((await run(checked(10))).status, "healthy");
  assert.equal((await mail()).length, 3, "recovery is reported once");
});

test("a misconfigured check alerts too, and a failed email is retried", async () => {
  await reset();
  const reject = async () => { throw new Error("mail provider down"); };
  const first = await runStoragePriceAudit({ check: checked(2, {}), notify: reject });
  assert.equal(first.status, "alert");
  assert.equal(first.delivered, "failed");
  assert.equal((await state())[0].notified_fingerprint, null, "an undelivered alert is not marked as sent");
  const retried = await runStoragePriceAudit({ check: checked(2, {}) });
  assert.equal(retried.delivered, "emailed");
  const sent = await mail();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /misconfigured: purchases paused/);
  assert.match(sent[0].text, /price_not_storage_rate/);
  assert.equal((await runStoragePriceAudit({ check: checked(2, {}) })).status, "ongoing");
});

test("the audit row does not disturb the service-price audit row", async () => {
  await reset();
  await db.execute(sql`INSERT INTO service_price_audit_state (audit_key, incident_fingerprint) VALUES ('service_prices', 'pattrack:missing')`);
  await runStoragePriceAudit({ check: checked(1) });
  const rows = (await db.execute(sql`SELECT audit_key, incident_fingerprint FROM service_price_audit_state ORDER BY audit_key`)).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.audit_key === "service_prices").incident_fingerprint, "pattrack:missing");
});
