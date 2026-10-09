// Periodic Stripe service-price audit: alert once per incident, report changes
// and recovery, survive restarts, retry failed delivery and stay read-only.
// Runs only inside the disposable fresh-schema database with captured email:
//   bash tests/run-fresh-schema.sh tests/service-price-audit.mjs
import assert from "node:assert/strict";
import test, { after } from "node:test";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")
    || !process.env.TEST_EMAIL_CAPTURE_PATH) {
  throw new Error("The service-price audit test requires the disposable database and captured email harness.");
}
const outbox = process.env.TEST_EMAIL_CAPTURE_PATH;
process.env.ADMIN_EMAIL = "operators@test.local";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const temp = await mkdtemp(path.join(testsDir, ".build-service-price-audit-"));
let lib;
try {
  const output = path.join(temp, "runtime.mjs");
  await build({
    entryPoints: [path.join(testsDir, "service-price-audit.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}
const { db, sql, pool, SERVICE_PRICE_CATALOGUE, evaluateServicePricePreflight, runServicePriceAudit, decideServicePriceAudit } = lib;
after(() => pool.end());

const required = SERVICE_PRICE_CATALOGUE.map((service) => service.key);
/** Synthetic catalogue: drop `missing` keys and add one extra row per `duplicate` key. */
const catalogue = ({ missing = [], duplicate = [] } = {}) => async () =>
  evaluateServicePricePreflight([...required.filter((key) => !missing.includes(key)), ...duplicate]);
const auditMail = async () => (await readFile(outbox, "utf8").catch(() => ""))
  .split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .filter((mail) => mail.subject.includes("Stripe service prices"));
const state = async () => (await db.execute(sql`SELECT * FROM service_price_audit_state`)).rows;
async function reset() {
  await db.execute(sql`DELETE FROM service_price_audit_state`);
  const kept = (await readFile(outbox, "utf8").catch(() => "")).split("\n").filter(Boolean)
    .filter((line) => !JSON.parse(line).subject.includes("Stripe service prices"));
  await writeFile(outbox, kept.map((line) => `${line}\n`).join(""));
}

test("alerts once per incident, re-alerts changes and reports recovery", async () => {
  await reset();
  let now = new Date("2026-10-01T09:25:00Z");
  const run = (preflight, extra = {}) => runServicePriceAudit({ readPreflight: preflight, now: () => now, ...extra });

  assert.equal((await run(catalogue())).status, "healthy");
  assert.equal((await auditMail()).length, 0, "a healthy catalogue sends nothing");

  const opened = await run(catalogue({ missing: ["pattrack"] }));
  assert.equal(opened.status, "alert");
  assert.equal(opened.delivered, "emailed");
  let mail = await auditMail();
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, "operators@test.local");
  assert.match(mail[0].subject, /need attention: PATtrack$/);
  assert.match(mail[0].text, /PATtrack \(pattrack\): no active monthly GBP price/);
  assert.match(mail[0].text, /nothing is deactivated automatically/);

  // Same unresolved incident: later runs and a process restart stay quiet,
  // because the incident is persisted rather than held in memory.
  now = new Date("2026-10-01T10:25:00Z");
  assert.equal((await run(catalogue({ missing: ["pattrack"] }))).status, "ongoing");
  assert.equal((await run(catalogue({ missing: ["pattrack"] }))).status, "ongoing");
  assert.equal((await auditMail()).length, 1, "the same incident must not be re-alerted");
  const [row] = await state();
  assert.equal(new Date(row.incident_opened_at).toISOString(), "2026-10-01T09:25:00.000Z");

  // A read failure is neither a recovery nor a new incident.
  const failed = await run(async () => { throw new Error("synced catalogue unavailable"); });
  assert.equal(failed.status, "read_failed");
  assert.equal((await state())[0].notified_fingerprint, row.notified_fingerprint);
  assert.equal((await auditMail()).length, 1);

  // The affected set changes: a duplicate appears.
  const changed = await run(catalogue({ missing: ["pattrack"], duplicate: ["fixtrack"] }));
  assert.equal(changed.status, "alert");
  mail = await auditMail();
  assert.equal(mail.length, 2);
  assert.match(mail[1].subject, /changed: FixTrack, PATtrack$/);
  assert.match(mail[1].text, /FixTrack \(fixtrack\): more than one active monthly GBP price/);

  // Partial recovery is reported as a change naming what was resolved.
  await run(catalogue({ duplicate: ["fixtrack"] }));
  mail = await auditMail();
  assert.equal(mail.length, 3);
  assert.match(mail[2].text, /No longer affected:\n- PATtrack \(pattrack\)/);

  now = new Date("2026-10-01T12:25:00Z");
  const recovered = await run(catalogue());
  assert.equal(recovered.status, "recovered");
  mail = await auditMail();
  assert.equal(mail.length, 4);
  assert.equal(mail[3].subject, "[ComplyTrack] Stripe service prices recovered");
  assert.match(mail[3].text, /Previously affected: FixTrack\./);
  assert.equal((await state())[0].incident_fingerprint, null);

  assert.equal((await run(catalogue())).status, "healthy");
  assert.equal((await auditMail()).length, 4, "recovery is reported once");
});

test("a failed delivery is retried on the next run rather than lost", async () => {
  await reset();
  const reject = async () => { throw new Error("provider down"); };
  const first = await runServicePriceAudit({ readPreflight: catalogue({ missing: ["doctrack"] }), notify: reject });
  assert.equal(first.delivered, "failed");
  assert.equal((await state())[0].notified_fingerprint, null);
  const retried = await runServicePriceAudit({ readPreflight: catalogue({ missing: ["doctrack"] }) });
  assert.equal(retried.status, "alert");
  assert.equal(retried.delivered, "emailed");
  assert.equal((await auditMail()).length, 1);
  assert.equal((await runServicePriceAudit({ readPreflight: catalogue({ missing: ["doctrack"] }) })).status, "ongoing");

  const recoveryFailed = await runServicePriceAudit({ readPreflight: catalogue(), notify: reject });
  assert.equal(recoveryFailed.delivered, "failed");
  assert.equal((await state())[0].incident_fingerprint, "doctrack:missing", "recovery notice must be retried");
  assert.equal((await runServicePriceAudit({ readPreflight: catalogue() })).status, "recovered");
  assert.equal((await auditMail()).length, 2);
});

test("concurrent runs (e.g. two instances) alert an incident exactly once", async () => {
  await reset();
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    runServicePriceAudit({ readPreflight: catalogue({ missing: ["kitchentrack"] }) })));
  assert.equal(results.filter((result) => result.status === "alert").length, 1);
  assert.equal((await auditMail()).length, 1);
});

test("without ADMIN_EMAIL the log is the alert and is not repeated", async () => {
  await reset();
  delete process.env.ADMIN_EMAIL;
  try {
    const logged = await runServicePriceAudit({ readPreflight: catalogue({ missing: ["treetrack"] }) });
    assert.equal(logged.delivered, "logged");
    assert.equal((await runServicePriceAudit({ readPreflight: catalogue({ missing: ["treetrack"] }) })).status, "ongoing");
    assert.equal((await auditMail()).length, 0);
  } finally {
    process.env.ADMIN_EMAIL = "operators@test.local";
  }
});

test("an incident that cleared before any alert was delivered clears quietly", () => {
  const decision = decideServicePriceAudit(
    { incidentFingerprint: "core:missing", incidentIssues: [], incidentOpenedAt: new Date(), notifiedFingerprint: null },
    { ready: true, issues: [] }, new Date());
  assert.equal(decision.kind, "cleared_unnotified");
});

test("the audit is read-only towards Stripe, prices, subscriptions and charges", async () => {
  const source = await readFile(path.join(apiDir, "src/lib/servicePriceAudit.ts"), "utf8");
  assert.doesNotMatch(source, /getUncachableStripeClient|getStripeSync|ensureServicePrices|stripe\.(?:prices|products|subscriptions|invoices)\.|subscriptions\.(?:update|cancel|del)|invoices\.create/);
  for (const write of source.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/g)) {
    assert.equal(write[2], "service_price_audit_state", `unexpected write: ${write[0]}`);
  }
  const startup = await readFile(path.join(apiDir, "src/index.ts"), "utf8");
  assert.match(startup, /cron\.schedule\(SERVICE_PRICE_AUDIT_CRON, runScheduledServicePriceAudit\)/);
});
