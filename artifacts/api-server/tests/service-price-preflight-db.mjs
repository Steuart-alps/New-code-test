// Real SQL coverage for the service-price readiness query and CLI. Builds a
// synthetic Stripe-mirror (`stripe.products` / `stripe.prices`) inside the
// disposable fresh-schema database only, then checks that inactive products,
// inactive prices, annual and multi-month prices, other currencies and unknown
// service keys never count as selectable, while duplicate active monthly rows
// do fail readiness. Run with:
//   bash tests/run-fresh-schema.sh tests/service-price-preflight-db.mjs
import assert from "node:assert/strict";
import test, { after } from "node:test";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("This test only runs against the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const temp = await mkdtemp(path.join(testsDir, ".build-service-price-db-"));
let lib;
try {
  const output = path.join(temp, "runtime.mjs");
  await build({
    entryPoints: [path.join(testsDir, "service-price-preflight-db.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}
const { db, sql, pool, SERVICE_PRICE_CATALOGUE, getServicePricePreflight, getServicePriceReadinessBlocker } = lib;
after(() => pool.end());

// Never adopt an existing mirror: the fresh-schema API does not run Stripe
// sync, so any pre-existing stripe.prices means this is not our fixture DB.
const existing = (await db.execute(sql`SELECT to_regclass('stripe.prices') AS t`)).rows[0].t;
if (existing) throw new Error("stripe.prices already exists; refusing to write Stripe-mirror fixtures");
await db.execute(sql`CREATE SCHEMA stripe`);
await db.execute(sql`CREATE TABLE stripe.products (id text PRIMARY KEY, active boolean NOT NULL, name text)`);
await db.execute(sql`CREATE TABLE stripe.prices (
  id text PRIMARY KEY, product text NOT NULL REFERENCES stripe.products(id), active boolean NOT NULL,
  currency text NOT NULL, unit_amount integer, recurring jsonb, metadata jsonb NOT NULL DEFAULT '{}'::jsonb)`);

const monthly = { interval: "month", interval_count: 1 };
let seq = 0;
async function price(key, { productActive = true, active = true, recurring = monthly, currency = "gbp", metadata } = {}) {
  seq += 1;
  const product = `prod_fixture_${seq}`;
  await db.execute(sql`INSERT INTO stripe.products (id, active, name) VALUES (${product}, ${productActive}, ${`Fixture ${key}`})`);
  await db.execute(sql`INSERT INTO stripe.prices (id, product, active, currency, unit_amount, recurring, metadata)
    VALUES (${`price_fixture_${seq}`}, ${product}, ${active}, ${currency}, 1000,
            ${recurring === null ? null : JSON.stringify(recurring)}::jsonb,
            ${JSON.stringify(metadata ?? { service_key: key })}::jsonb)`);
  return `price_fixture_${seq}`;
}

const required = SERVICE_PRICE_CATALOGUE.map((service) => service.key);
const labelOf = Object.fromEntries(SERVICE_PRICE_CATALOGUE.map((service) => [service.key, service.label]));
// Services whose only candidate rows are not selectable.
const trapOnly = {
  pattrack: { productActive: false },                              // inactive product
  doctrack: { active: false },                                     // inactive price
  fixtrack: { recurring: { interval: "year", interval_count: 1 } }, // annual
  treetrack: { recurring: { interval: "month", interval_count: 3 } }, // every 3 months
  biketrack: { currency: "eur" },                                  // wrong currency
  roomtrack: { recurring: null },                                  // one-off price
};
const duplicated = ["kitchentrack", "bundle"];

for (const key of required) {
  if (trapOnly[key]) {
    await price(key, trapOnly[key]);
    continue;
  }
  await price(key);
  if (duplicated.includes(key)) await price(key);
}
// Non-selectable extras beside a valid price must not create a duplicate.
await price("core", { productActive: false });
await price("core", { active: false });
await price("core", { recurring: { interval: "year", interval_count: 1 } });
await price("core", { recurring: { interval: "month", interval_count: 2 } });
// Unknown keys and unkeyed prices are ignored, even when duplicated.
await price("mysterytrack");
await price("mysterytrack");
await price("unkeyed", { metadata: {} });

const expectedMissing = required.filter((key) => trapOnly[key]);
const expectedIssues = SERVICE_PRICE_CATALOGUE
  .filter((service) => trapOnly[service.key] || duplicated.includes(service.key))
  .map((service) => ({ key: service.key, label: service.label, reason: trapOnly[service.key] ? "missing" : "duplicate" }));

const mirrorSnapshot = async () => JSON.stringify((await db.execute(sql`
  SELECT 'product' AS kind, id, active::text AS state FROM stripe.products
  UNION ALL SELECT 'price', id, active::text || metadata::text || COALESCE(recurring::text, '') FROM stripe.prices
  ORDER BY 1, 2`)).rows);

async function runCli() {
  const cli = path.join(apiDir, "scripts/check-service-prices.mjs");
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli], { env: process.env, cwd: apiDir });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test("readiness query rejects inactive, annual, multi-month, foreign-currency and one-off prices", async () => {
  const result = await getServicePricePreflight();
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, expectedMissing);
  assert.deepEqual(result.duplicates, duplicated);
  assert.deepEqual(result.issues, expectedIssues);
  assert.ok(result.configured.includes("core"), "non-selectable extras must not make a valid price ambiguous");
  assert.ok(!result.required.includes("mysterytrack"));
  assert.ok(!result.configured.includes("mysterytrack"), "unknown service keys are ignored");
  assert.equal(getServicePriceReadinessBlocker({ catalogueReadFailed: false, repairFailed: false, finalPreflight: result }),
    "Required Stripe service prices are duplicated");
});

test("CLI names every affected service, exits non-zero and changes nothing", async () => {
  const before = await mirrorSnapshot();
  const { code, stdout, stderr } = await runCli();
  assert.equal(code, 1, stdout + stderr);
  const lines = stderr.trim().split("\n");
  assert.deepEqual(lines, expectedIssues.map((issue) => `${issue.label} (${issue.key}): ${
    issue.reason === "missing" ? "missing active monthly price" : "duplicate active monthly prices"}`));
  for (const key of ["mysterytrack", "core", "firetrack"]) assert.doesNotMatch(stderr, new RegExp(`\\(${key}\\)`));
  assert.equal(await mirrorSnapshot(), before, "the readiness CLI must not modify the Stripe mirror");
  assert.ok(labelOf.pattrack && stderr.includes("PATtrack (pattrack): missing active monthly price"));
});

test("missing-only catalogue reports missing; a complete catalogue passes", async () => {
  // Resolve duplicates in the disposable fixture only.
  await db.execute(sql`UPDATE stripe.prices SET active = false
    WHERE id IN (SELECT max(id) FROM stripe.prices WHERE active AND metadata->>'service_key' IN ('kitchentrack', 'bundle')
                 GROUP BY metadata->>'service_key')`);
  const missingOnly = await getServicePricePreflight();
  assert.deepEqual(missingOnly.duplicates, []);
  assert.equal(getServicePriceReadinessBlocker({ catalogueReadFailed: false, repairFailed: false, finalPreflight: missingOnly }),
    "Required Stripe service prices are missing");

  for (const key of expectedMissing) await price(key);
  const complete = await getServicePricePreflight();
  assert.equal(complete.ready, true, JSON.stringify(complete.issues));
  assert.deepEqual(complete.configured, required);
  const { code, stdout } = await runCli();
  assert.equal(code, 0);
  assert.equal(stdout.trim(), `Service-price readiness passed for ${required.length} services.`);
});
