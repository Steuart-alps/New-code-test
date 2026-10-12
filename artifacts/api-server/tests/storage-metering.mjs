// Storage pricing boundaries and download metering, through the real API.
//
// Runs only through tests/run-fresh-schema.sh (disposable database). The suite
// bundles the app in-process with two external services replaced: the Google
// Cloud Storage bucket (in-memory, streamed in chunks) and the Stripe
// subscription lookup used by the cost estimate. Everything else is real:
// sessions, tenant checks, ACLs, range handling, the download ledger and the
// month aggregate.
//
// Commercial rules protected here:
//   - storage over the plan's included GiB (binary, 1024^3) is estimated at
//     provider cost plus the ALPS markup, in integer minor units;
//   - invalid pricing configuration hides the estimate instead of guessing;
//   - download traffic is measured and shown, but never priced.
import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.env.FRESH_SCHEMA_TEST !== "1" || !process.env.DATABASE_URL) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/storage-metering.mjs (disposable database only)");
}

const GIB = 1024 ** 3;
const BUCKET = "storage-metering-test-bucket";
const PRICING_ENV = ["STORAGE_PROVIDER_USD_PER_GIB_MONTH", "STORAGE_ALPS_MARKUP_PERCENT", "STORAGE_INCLUDED_GIB_BY_SERVICE"];

process.env.SESSION_SECRET ||= "storage-metering-test-only-not-a-real-secret";
process.env.PRIVATE_OBJECT_DIR = `/${BUCKET}/private`;
process.env.PUBLIC_OBJECT_SEARCH_PATHS = `/${BUCKET}/public`;
process.env.LOG_LEVEL ||= "error";
for (const name of PRICING_ENV) delete process.env[name];

let passed = 0;
const failures = [];
let stampCounter = 0;
const stamp = () => `${Date.now()}-${++stampCounter}`;
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}${detail ? `: ${detail}` : ""}`); console.error(`FAIL: ${name}${detail ? `: ${detail}` : ""}`); }
}
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);


// ─── helpers ────────────────────────────────────────────────────────────────

function session(base) {
  let cookie = "";
  return async (method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json")
      ? await response.json().catch(() => null)
      : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, headers: response.headers };
  };
}

async function registerTenant(base, label, stamp) {
  const user = session(base);
  const email = `storage-metering-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `Storage ${label}`, email, password: "password-123" });
  if (![200, 201].includes(registered.status)) throw new Error(`register ${label}: ${registered.status} ${JSON.stringify(registered.data)}`);
  await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const login = await user("POST", "/auth/login", { email, password: "password-123" });
  if (login.status !== 200) throw new Error(`login ${label}: ${login.status} ${JSON.stringify(login.data)}`);
  const me = await user("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;
  if (!Number.isSafeInteger(clientId)) throw new Error(`no client for ${label}`);
  return { user, clientId };
}

const query = async (text, params = []) => (await t.pool.query(text, params)).rows;
const eventRows = (clientId) =>
  query("SELECT event_id, month, bytes::bigint AS bytes FROM storage_download_events WHERE client_id = $1 ORDER BY id", [clientId])
    .then((rows) => rows.map((row) => ({ ...row, bytes: Number(row.bytes) })));
const monthRows = (clientId) =>
  query("SELECT month, bytes::bigint AS bytes FROM storage_download_months WHERE client_id = $1 ORDER BY month", [clientId])
    .then((rows) => rows.map((row) => ({ month: row.month, bytes: Number(row.bytes) })));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Metering commits after the response stream settles; wait for it, then for stragglers. */
async function settledEvents(clientId, atLeast, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await eventRows(clientId);
  while (rows.length < atLeast && Date.now() < deadline) {
    await sleep(25);
    rows = await eventRows(clientId);
  }
  await sleep(150);
  return eventRows(clientId);
}

function tokenFromUrl(url) {
  return new URL(url).pathname.split("/").pop();
}

/** Raw request so the test controls exactly how much of the body it reads. */
function rawGet(base, route, { headers = {}, abortAfterBytes } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${route}`, { headers }, (response) => {
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
        if (abortAfterBytes !== undefined && received >= abortAfterBytes) {
          request.destroy();
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), aborted: true });
        }
      });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), aborted: false }));
      // The server cut the body short (e.g. the provider stream failed).
      response.on("error", () => {});
      response.on("close", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), aborted: !response.complete, cut: !response.complete }));
    });
    request.on("error", (error) => { if (abortAfterBytes === undefined) reject(error); });
  });
}

// ─── suite ──────────────────────────────────────────────────────────────────

async function main(base) {
  const runId = Date.now();
  const tenantA = await registerTenant(base, "a", runId);
  const tenantB = await registerTenant(base, "b", runId);
  const pricing = await registerTenant(base, "pricing", runId);
  const month = t.utcMonth();

  await utcMonthBoundaries();
  await pricingBoundaries(pricing);
  await ledgerIdempotency(tenantA, tenantB);
  await monthAggregation(tenantA, tenantB, month);
  await downloads(base, tenantA, tenantB, month);
  await downloadsDisplayedNotBilled(tenantA, pricing, month);
}

async function utcMonthBoundaries() {
  console.log("\n── UTC month keys ──");
  same("last millisecond of October is October", t.utcMonth(new Date("2026-10-31T23:59:59.999Z")), "2026-10");
  same("first millisecond of November is November", t.utcMonth(new Date("2026-11-01T00:00:00.000Z")), "2026-11");
  // 00:30 on 1 Nov in Europe/London during BST would be 31 Oct 23:30 UTC; months are UTC.
  same("month key ignores UK local time", t.utcMonth(new Date("2026-03-31T23:30:00.000Z")), "2026-03");
  same("year rollover", t.utcMonth(new Date("2026-12-31T23:59:59.999Z")), "2026-12");
}

async function pricingBoundaries({ user, clientId }) {
  console.log("\n── storage pricing boundaries ──");
  const customer = `cus_storage_metering_${clientId}`;
  await query("UPDATE clients SET stripe_customer_id = $1 WHERE id = $2", [customer, clientId]);
  t.setTestSubscription(customer, ["core"]);
  const prefix = `private/finalized/tenant-${clientId}/`;
  const usage = async (usedBytes, env = {}) => {
    t.clearObjects(prefix);
    if (usedBytes > 0) t.putObject(`${prefix}stored.bin`, { size: usedBytes, owner: String(clientId) });
    for (const name of PRICING_ENV) delete process.env[name];
    Object.assign(process.env, env);
    try {
      const response = await user("GET", "/storage/usage");
      if (response.status !== 200) throw new Error(`usage ${response.status} ${JSON.stringify(response.data)}`);
      return response.data;
    } finally {
      for (const name of PRICING_ENV) delete process.env[name];
    }
  };
  const cost = async (usedBytes, env) => (await usage(usedBytes, env)).estimatedCost;
  const minorUnitsAreIntegers = (estimate) =>
    ["storageMinorUnits", "downloadMinorUnits", "totalMinorUnits", "providerMinorUnits", "markupMinorUnits"]
      .every((key) => Number.isSafeInteger(estimate?.[key]));
  const nothingDue = (name, estimate, excess) => {
    check(`${name}: estimate shown`, estimate !== null, JSON.stringify(estimate));
    same(`${name}: excess bytes`, estimate?.excessStorageBytes, excess);
    same(`${name}: nothing to pay`, [estimate?.providerMinorUnits, estimate?.markupMinorUnits, estimate?.storageMinorUnits, estimate?.totalMinorUnits], [0, 0, 0, 0]);
  };

  const zero = await usage(0);
  same("zero usage: used bytes", [zero.usedBytes, zero.objectCount], [0, 0]);
  nothingDue("zero usage", zero.estimatedCost, 0);
  same("zero usage: core plan includes exactly 1 GiB", zero.estimatedCost?.includedStorageBytes, GIB);
  same("zero usage: USD, 20% default markup", [zero.estimatedCost?.currency, zero.estimatedCost?.markupPercent], ["USD", 20]);

  nothingDue("1 GB (decimal) is inside the 1 GiB allowance", await cost(1_000_000_000), 0);
  nothingDue("exactly 1 GiB is inside the allowance", await cost(GIB), 0);
  nothingDue("1 GiB - 1 byte is inside the allowance", await cost(GIB - 1), 0);

  const oneOver = await cost(GIB + 1);
  nothingDue("1 GiB + 1 byte: one excess byte rounds to zero cents", oneOver, 1);

  // $0.015/GiB: half a GiB over is 0.75c provider, 0.9c with markup; each rounds to 1c.
  const half = await cost(GIB + GIB / 2);
  same("1.5 GiB: half a GiB excess", half?.excessStorageBytes, GIB / 2);
  same("1.5 GiB: provider/markup/storage/total cents", [half?.providerMinorUnits, half?.markupMinorUnits, half?.storageMinorUnits, half?.totalMinorUnits], [1, 0, 1, 1]);

  const hundred = await cost(101 * GIB);
  same("101 GiB: 100 GiB excess", hundred?.excessStorageBytes, 100 * GIB);
  same("101 GiB: $1.50 provider + $0.30 (20%) markup = $1.80", [hundred?.providerMinorUnits, hundred?.markupMinorUnits, hundred?.storageMinorUnits, hundred?.totalMinorUnits], [150, 30, 180, 180]);
  check("101 GiB: all amounts are integer minor units", minorUnitsAreIntegers(hundred), JSON.stringify(hundred));

  const fractional = await cost(Math.round(101.5 * GIB));
  same("101.5 GiB: provider 150.75c → 151c, with markup 180.9c → 181c", [fractional?.providerMinorUnits, fractional?.markupMinorUnits, fractional?.storageMinorUnits], [151, 30, 181]);
  check("101.5 GiB: all amounts are integer minor units", minorUnitsAreIntegers(fractional), JSON.stringify(fractional));

  const thousand = await cost(1001 * GIB, { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0.02" });
  same("1000 GiB excess at $0.02: $20.00 provider + $4.00 markup", [thousand?.providerMinorUnits, thousand?.markupMinorUnits, thousand?.storageMinorUnits], [2000, 400, 2400]);
  // Markup is applied to the exact provider cost, then rounded once: never a fraction of a cent.
  for (const gib of [3, 7, 33, 333, 1234]) {
    const estimate = await cost((gib + 1) * GIB);
    const exact = 1.5 * gib;
    same(`${gib} GiB excess: storage is round(provider × 1.2)`, estimate?.storageMinorUnits, Math.round(exact * 1.2));
    same(`${gib} GiB excess: markup + provider = storage`, (estimate?.providerMinorUnits ?? NaN) + (estimate?.markupMinorUnits ?? NaN), estimate?.storageMinorUnits);
    check(`${gib} GiB excess: integer minor units`, minorUnitsAreIntegers(estimate), JSON.stringify(estimate));
  }

  const fractionalAllowance = await cost(GIB + GIB / 2, { STORAGE_INCLUDED_GIB_BY_SERVICE: JSON.stringify({ core: 1.5 }) });
  nothingDue("1.5 GiB allowance covers exactly 1.5 GiB", fractionalAllowance, 0);
  same("1.5 GiB allowance in bytes", fractionalAllowance?.includedStorageBytes, GIB + GIB / 2);
  nothingDue("zero allowance with zero usage", await cost(0, { STORAGE_INCLUDED_GIB_BY_SERVICE: JSON.stringify({ core: 0 }) }), 0);
  same("zero markup: storage equals provider cost", (await cost(101 * GIB, { STORAGE_ALPS_MARKUP_PERCENT: "0" }))?.storageMinorUnits, 150);

  t.setTestSubscription(customer, ["core", "bundle"]);
  same("largest allowance among subscribed services applies",
    (await cost(4 * GIB, { STORAGE_INCLUDED_GIB_BY_SERVICE: JSON.stringify({ core: 1, bundle: 5 }) }))?.excessStorageBytes, 0);
  t.setTestSubscription(customer, ["core"]);

  console.log("\n── invalid pricing configuration hides the estimate ──");
  const invalid = {
    "non-numeric provider rate": { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "abc" },
    "negative provider rate": { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "-0.015" },
    "infinite provider rate": { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "Infinity" },
    "non-numeric markup": { STORAGE_ALPS_MARKUP_PERCENT: "twenty" },
    "negative markup": { STORAGE_ALPS_MARKUP_PERCENT: "-20" },
    "allowances not JSON": { STORAGE_INCLUDED_GIB_BY_SERVICE: "core=1" },
    "allowances JSON null": { STORAGE_INCLUDED_GIB_BY_SERVICE: "null" },
    "allowances array": { STORAGE_INCLUDED_GIB_BY_SERVICE: "[1]" },
    "allowances empty": { STORAGE_INCLUDED_GIB_BY_SERVICE: "{}" },
    "allowance as string": { STORAGE_INCLUDED_GIB_BY_SERVICE: JSON.stringify({ core: "1" }) },
    "negative allowance": { STORAGE_INCLUDED_GIB_BY_SERVICE: JSON.stringify({ core: -1 }) },
    "allowance beyond safe bytes": { STORAGE_INCLUDED_GIB_BY_SERVICE: JSON.stringify({ core: 1e9 }) },
    "subscribed service has no allowance": { STORAGE_INCLUDED_GIB_BY_SERVICE: JSON.stringify({ bundle: 1 }) },
  };
  for (const [name, env] of Object.entries(invalid)) {
    const response = await usage(101 * GIB, env);
    check(`${name}: usage still answers`, Number.isSafeInteger(response.usedBytes) && response.usedBytes === 101 * GIB, JSON.stringify(response));
    same(`${name}: no estimate`, response.estimatedCost, null);
  }
  same("unset (empty) provider rate uses the $0.015 default", (await cost(101 * GIB, { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "" }))?.providerMinorUnits, 150);
  same("unset (empty) markup uses the 20% default", (await cost(101 * GIB, { STORAGE_ALPS_MARKUP_PERCENT: "" }))?.markupMinorUnits, 30);
  // Blank values are unset, never zero: a stray space must not drop the margin to 0%.
  same("blank provider rate uses the default", (await cost(101 * GIB, { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "  " }))?.providerMinorUnits, 150);
  const blankMarkup = await cost(101 * GIB, { STORAGE_ALPS_MARKUP_PERCENT: " " });
  same("blank markup uses the 20% default, not 0%", [blankMarkup?.markupPercent, blankMarkup?.markupMinorUnits], [20, 30]);

  t.setTestSubscription(customer, null);
  same("no live subscription: no estimate", await cost(101 * GIB), null);
  t.setTestSubscription(customer, ["core"]);
  await query("UPDATE clients SET stripe_customer_id = NULL WHERE id = $1", [clientId]);
  const lookups = t.stripeLookups.length;
  same("no Stripe customer: no estimate", await cost(101 * GIB), null);
  same("no Stripe customer: no subscription lookup", t.stripeLookups.length, lookups);
  await query("UPDATE clients SET stripe_customer_id = $1 WHERE id = $2", [customer, clientId]);
  t.clearObjects(prefix);
}

async function ledgerIdempotency(tenantA, tenantB) {
  console.log("\n── download ledger idempotency ──");
  const a = tenantA.clientId;
  const before = await t.getMonthlyDownloadBytes(a);
  const eventId = `idempotency-${a}-${Date.now()}`;
  await t.recordDownloadBytes(a, 1000, eventId);
  await t.recordDownloadBytes(a, 1000, eventId);
  await Promise.all(Array.from({ length: 8 }, () => t.recordDownloadBytes(a, 1000, eventId)));
  same("replayed and concurrent commits of one event count once", await t.getMonthlyDownloadBytes(a) - before, 1000);
  same("one ledger row per event", (await eventRows(a)).filter((row) => row.event_id === eventId).length, 1);
  // A replayed event id cannot be redirected to another tenant or size.
  await t.recordDownloadBytes(tenantB.clientId, 999_999, eventId);
  await t.recordDownloadBytes(a, 999_999, eventId);
  same("replay with different tenant or size changes nothing", [await t.getMonthlyDownloadBytes(a) - before, await t.getMonthlyDownloadBytes(tenantB.clientId)], [1000, 0]);

  const rowsBefore = (await eventRows(a)).length;
  for (const bytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await t.recordDownloadBytes(a, bytes, `invalid-${String(bytes)}-${Date.now()}`);
  }
  same("zero, negative, fractional and unsafe byte counts are not recorded", [(await eventRows(a)).length, await t.getMonthlyDownloadBytes(a) - before], [rowsBefore, 1000]);

  const meter = t.createDownloadMeter(a);
  meter.add(Buffer.alloc(10));
  meter.add(new Uint8Array(5));
  meter.add("héllo"); // 6 UTF-8 bytes
  await Promise.all([meter.commit(), meter.commit()]);
  await meter.commit();
  same("meter counts UTF-8 bytes and commits once despite end/close/replay", (await eventRows(a)).filter((row) => row.event_id === meter.eventId).map((row) => row.bytes), [21]);
  same("meter total lands in the month aggregate", await t.getMonthlyDownloadBytes(a) - before, 1021);

  const empty = t.createDownloadMeter(a);
  await empty.commit();
  same("an empty response records no event", (await eventRows(a)).some((row) => row.event_id === empty.eventId), false);
}

async function monthAggregation(tenantA, tenantB, month) {
  console.log("\n── month aggregation ──");
  const a = tenantA.clientId, b = tenantB.clientId;
  const aBefore = await t.getMonthlyDownloadBytes(a), bBefore = await t.getMonthlyDownloadBytes(b);
  await t.recordDownloadBytes(a, 300, `agg-a1-${Date.now()}`);
  await t.recordDownloadBytes(a, 700, `agg-a2-${Date.now()}`);
  await t.recordDownloadBytes(b, 50, `agg-b1-${Date.now()}`);
  same("aggregate sums each tenant's own events", [await t.getMonthlyDownloadBytes(a) - aBefore, await t.getMonthlyDownloadBytes(b) - bBefore], [1000, 50]);

  // Each month aggregate equals its ledger, per tenant.
  for (const clientId of [a, b]) {
    const ledger = await query(
      "SELECT month, sum(bytes)::bigint AS bytes FROM storage_download_events WHERE client_id = $1 GROUP BY month ORDER BY month",
      [clientId],
    );
    same(`client ${clientId === a ? "A" : "B"}: month aggregate matches its ledger`, await monthRows(clientId), ledger.map((row) => ({ month: row.month, bytes: Number(row.bytes) })));
  }

  // Events are keyed to the UTC month at commit time; months never mix.
  const RealDate = Date;
  const freeze = (iso) => {
    const fixed = new RealDate(iso).getTime();
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    };
  };
  try {
    freeze("2025-01-31T23:59:59.999Z");
    await t.recordDownloadBytes(a, 11, `agg-jan-${stamp()}`);
    freeze("2025-02-01T00:00:00.000Z");
    await t.recordDownloadBytes(a, 22, `agg-feb-${stamp()}`);
  } finally {
    globalThis.Date = RealDate;
  }
  same("January's last millisecond and February's first land in their own months",
    [await t.getMonthlyDownloadBytes(a, "2025-01"), await t.getMonthlyDownloadBytes(a, "2025-02")], [11, 22]);
  same("past months do not leak into the current month", await t.getMonthlyDownloadBytes(a, month) - aBefore, 1000);
  same("other tenants have no traffic in those months", [await t.getMonthlyDownloadBytes(b, "2025-01"), await t.getMonthlyDownloadBytes(b, "2025-02")], [0, 0]);
  same("a month with no traffic reads as zero", await t.getMonthlyDownloadBytes(a, "1999-12"), 0);

  const usage = await tenantA.user("GET", "/storage/usage");
  same("usage endpoint reports the current UTC month", usage.data?.month, month);
  same("usage endpoint shows only this month's traffic", usage.data?.monthlyDownloadBytes, await t.getMonthlyDownloadBytes(a, month));
}

async function downloads(base, tenantA, tenantB, month) {
  console.log("\n── download metering ──");
  const a = tenantA.clientId, b = tenantB.clientId;
  const content = randomBytes(300_000);
  const objectPath = `/objects/uploads/tenant-${a}/metering-${stamp()}.bin`;
  const objectName = `private${objectPath.slice("/objects".length)}`;
  t.putObject(objectName, { bytes: content, owner: String(a), chunkSize: 16 * 1024 });
  const storage = new t.ObjectStorageService();
  const tokenUrl = await storage.getSignedDownloadURL(objectPath, 900, undefined, a);
  const token = tokenFromUrl(tokenUrl);
  check("signed download link is an API token URL, not a provider URL", /\/api\/storage\/download\/[A-Za-z0-9_-]{40,60}$/.test(tokenUrl), tokenUrl);

  const meteredSince = async (count, fn) => {
    const before = (await eventRows(a)).length;
    const result = await fn();
    const rows = await settledEvents(a, before + count);
    return { result, events: rows.slice(before) };
  };

  // Full download.
  const full = await meteredSince(1, () => rawGet(base, `/storage/download/${token}`));
  same("full, without a session: 200 with the whole object", [full.result.status, full.result.body.equals(content)], [200, true]);
  same("full: Content-Length is the object size", full.result.headers["content-length"], String(content.length));
  same("full: one event for exactly the bytes served", full.events.map((row) => [row.bytes, row.month]), [[content.length, month]]);

  // Ranged downloads.
  const ranges = [
    ["bytes=100-199", 100, 199],
    ["bytes=299990-", 299_990, 299_999],
    ["bytes=-25", 299_975, 299_999],
    ["bytes=0-999999999", 0, 299_999],
  ];
  for (const [header, start, end] of ranges) {
    const ranged = await meteredSince(1, () => rawGet(base, `/storage/download/${token}`, { headers: { range: header } }));
    same(`range ${header}: 206 with the requested slice`, [ranged.result.status, ranged.result.body.equals(content.subarray(start, end + 1))], [206, true]);
    same(`range ${header}: Content-Range`, ranged.result.headers["content-range"], `bytes ${start}-${end}/${content.length}`);
    same(`range ${header}: metered at the slice size`, ranged.events.map((row) => row.bytes), [end - start + 1]);
  }
  for (const header of ["bytes=300000-", "bytes=5-2", "bytes=-0"]) {
    const refused = await meteredSince(0, () => rawGet(base, `/storage/download/${token}`, { headers: { range: header } }));
    same(`unsatisfiable range ${header}: 416`, [refused.result.status, refused.result.headers["content-range"]], [416, `bytes */${content.length}`]);
    same(`unsatisfiable range ${header}: nothing metered`, refused.events.length, 0);
  }

  // Retry: each response is separate traffic, never merged or deduplicated.
  const retried = await meteredSince(2, async () => [
    await rawGet(base, `/storage/download/${token}`),
    await rawGet(base, `/storage/download/${token}`),
  ]);
  same("retry: both attempts served", retried.result.map((r) => r.status), [200, 200]);
  same("retry: two distinct events, each the full size", [retried.events.length, new Set(retried.events.map((row) => row.event_id)).size, retried.events.map((row) => row.bytes)], [2, 2, [content.length, content.length]]);

  // Partial: the client disconnects mid-stream from a slow provider read.
  const slowPath = `/objects/uploads/tenant-${a}/slow-${stamp()}.bin`;
  const slowContent = randomBytes(64 * 1024 * 40);
  t.putObject(`private${slowPath.slice("/objects".length)}`, { bytes: slowContent, owner: String(a), chunkSize: 64 * 1024, chunkDelayMs: 20 });
  const slowToken = tokenFromUrl(await storage.getSignedDownloadURL(slowPath, 900, undefined, a));
  const readsBefore = t.providerReads.length;
  const partial = await meteredSince(1, () => rawGet(base, `/storage/download/${slowToken}`, { abortAfterBytes: 64 * 1024 }));
  await sleep(300);
  const providerRead = t.providerReads[readsBefore];
  check("partial: client disconnected before the end", partial.result.aborted && partial.result.body.length < slowContent.length, `received ${partial.result.body.length}`);
  same("partial: exactly one event is committed", partial.events.length, 1);
  check("partial: metered bytes cover what the client received and stay below the object size",
    partial.events.length === 1 && partial.events[0].bytes >= partial.result.body.length && partial.events[0].bytes < slowContent.length,
    JSON.stringify({ metered: partial.events.map((row) => row.bytes), received: partial.result.body.length, size: slowContent.length }));
  check("partial: the provider read stops after the client leaves", providerRead && !providerRead.finished && providerRead.emitted < slowContent.length,
    JSON.stringify(providerRead));
  check("partial: never metered above what the provider streamed", partial.events.every((row) => providerRead && row.bytes <= providerRead.emitted), JSON.stringify(providerRead));

  // Partial: the provider stream fails mid-way.
  const failingPath = `/objects/uploads/tenant-${a}/failing-${stamp()}.bin`;
  const failingContent = randomBytes(64 * 1024 * 4);
  t.putObject(`private${failingPath.slice("/objects".length)}`, { bytes: failingContent, owner: String(a), chunkSize: 64 * 1024, failAfterBytes: 64 * 1024 * 2 });
  const failingToken = tokenFromUrl(await storage.getSignedDownloadURL(failingPath, 900, undefined, a));
  const failed = await meteredSince(1, () => rawGet(base, `/storage/download/${failingToken}`).catch((error) => ({ error })));
  same("provider failure: one event for the bytes actually streamed", failed.events.map((row) => row.bytes), [64 * 1024 * 2]);
  same("provider failure: the client sees a cut-off body, not a complete file", failed.result.error !== undefined || (failed.result.cut === true && failed.result.body.length < failingContent.length), true);
  same("provider failure: the API keeps serving", (await tenantA.user("GET", "/storage/usage")).status, 200);

  // Expired token.
  const expiring = tokenFromUrl(await storage.getSignedDownloadURL(objectPath, 900, undefined, a));
  const expiringDigest = createHash("sha256").update(expiring, "utf8").digest("hex");
  same("expiring token: valid before expiry", (await t.resolveDownloadToken(expiring))?.clientId, a);
  await query("UPDATE storage_download_tokens SET expires_at = now() - interval '1 second' WHERE token_digest = $1", [expiringDigest]);
  const expired = await meteredSince(0, () => rawGet(base, `/storage/download/${expiring}`));
  same("expired token: 404", expired.result.status, 404);
  same("expired token: nothing metered", expired.events.length, 0);
  same("expired token: not resolvable", await t.resolveDownloadToken(expiring), null);
  for (const bad of ["not-a-token", "A".repeat(43), `${token}x`.slice(0, 39)]) {
    const unknown = await meteredSince(0, () => rawGet(base, `/storage/download/${bad}`));
    same(`unknown token ${bad.slice(0, 12)}…: 404, nothing metered`, [unknown.result.status, unknown.events.length], [404, 0]);
  }

  // Foreign tenant.
  const bPath = `/objects/uploads/tenant-${b}/foreign-${stamp()}.bin`;
  t.putObject(`private${bPath.slice("/objects".length)}`, { bytes: randomBytes(4096), owner: String(b) });
  const bEventsBefore = (await eventRows(b)).length;
  let refusedSigning = false;
  try { await storage.getSignedDownloadURL(bPath, 900, undefined, a); } catch (error) { refusedSigning = error instanceof t.ObjectOwnershipError; }
  check("foreign tenant: a link for another tenant's object is refused", refusedSigning);
  same("foreign tenant: refused link stores no token", Number((await query("SELECT count(*) FROM storage_download_tokens WHERE object_path = $1", [bPath]))[0].count), 0);
  // A token row naming tenant A for B's object (forged or stale) is still refused by the object ACL.
  const forged = tokenFromUrl(await t.createDownloadToken(bPath, a, 900));
  const forgedDownload = await meteredSince(0, () => rawGet(base, `/storage/download/${forged}`));
  same("foreign tenant: token for another tenant's object → 404", forgedDownload.result.status, 404);
  same("foreign tenant: nothing metered to the requester", forgedDownload.events.length, 0);
  same("foreign tenant: nothing metered to the owner", (await eventRows(b)).length, bEventsBefore);

  // Session downloads by object path.
  const own = await meteredSince(1, () => tenantA.user("GET", `/storage${objectPath}`));
  same("session download: own object served", [own.result.status, Buffer.isBuffer(own.result.data) && own.result.data.equals(content)], [200, true]);
  same("session download: metered to the session's tenant", own.events.map((row) => row.bytes), [content.length]);
  const ownRange = await meteredSince(1, () => tenantA.user("GET", `/storage${objectPath}`, undefined, { range: "bytes=0-9" }));
  same("session range: 206, metered at 10 bytes", [ownRange.result.status, ownRange.events.map((row) => row.bytes)], [206, [10]]);
  const aBefore = (await eventRows(a)).length;
  const crossPath = await tenantA.user("GET", `/storage${bPath}`);
  same("session download: another tenant's path → 403", crossPath.status, 403);
  // B's object copied under A's prefix keeps B's ACL; the ACL refuses it too.
  const disguisedPath = `/objects/uploads/tenant-${a}/disguised-${stamp()}.bin`;
  t.putObject(`private${disguisedPath.slice("/objects".length)}`, { bytes: randomBytes(1024), owner: String(b) });
  same("session download: object owned by another tenant under own prefix → 403", (await tenantA.user("GET", `/storage${disguisedPath}`)).status, 403);
  await sleep(200);
  same("refused session downloads meter nothing for either tenant", [(await eventRows(a)).length - aBefore, (await eventRows(b)).length - bEventsBefore], [0, 0]);
  const anonymous = await session(base)("GET", `/storage${objectPath}`);
  same("anonymous session download → 401", anonymous.status, 401);
}

async function downloadsDisplayedNotBilled(tenantA, pricing, month) {
  console.log("\n── download traffic is displayed but not billed ──");
  const customer = `cus_storage_metering_a_${tenantA.clientId}`;
  await query("UPDATE clients SET stripe_customer_id = $1 WHERE id = $2", [customer, tenantA.clientId]);
  t.setTestSubscription(customer, ["core"]);
  const a = await tenantA.user("GET", "/storage/usage");
  const ledger = await t.getMonthlyDownloadBytes(tenantA.clientId, month);
  check("tenant A has metered download traffic this month", ledger > 0, String(ledger));
  same("usage shows A's metered traffic", [a.data?.monthlyDownloadBytes, a.data?.monthlyDownloadTrackingAvailable], [ledger, true]);
  same("A's traffic is not priced", [a.data?.estimatedCost?.downloadMinorUnits, a.data?.estimatedCost?.totalMinorUnits], [0, a.data?.estimatedCost?.storageMinorUnits]);

  // Same stored bytes before and after heavy traffic: the estimate is unchanged.
  const prefix = `private/finalized/tenant-${pricing.clientId}/`;
  t.clearObjects(prefix);
  t.putObject(`${prefix}stored.bin`, { size: 101 * GIB, owner: String(pricing.clientId) });
  const before = await pricing.user("GET", "/storage/usage");
  await t.recordDownloadBytes(pricing.clientId, 500 * GIB, `heavy-${stamp()}`);
  const after = await pricing.user("GET", "/storage/usage");
  same("heavy traffic is displayed", after.data?.monthlyDownloadBytes - before.data?.monthlyDownloadBytes, 500 * GIB);
  same("estimate is identical with or without 500 GiB of downloads", after.data?.estimatedCost, before.data?.estimatedCost);
  same("downloads add nothing to the total", [after.data?.estimatedCost?.downloadMinorUnits, after.data?.estimatedCost?.totalMinorUnits], [0, 180]);

  t.clearObjects(prefix);
  const withinAllowance = await pricing.user("GET", "/storage/usage");
  same("within the allowance, downloads alone cost nothing", [withinAllowance.data?.monthlyDownloadBytes >= 500 * GIB, withinAllowance.data?.estimatedCost?.totalMinorUnits], [true, 0]);
}

// ─── run (last, so every helper above is initialised) ───────────────────────

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-storage-metering-"));
let t;
let server;
try {
  const outfile = path.join(outDir, "entry.mjs");
  const billingStub = path.join(dir, "storage-metering-billing.stub.ts");
  const storageRoute = path.join(dir, "..", "src", "routes", "storage.ts");
  await build({
    entryPoints: [path.join(dir, "storage-metering.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
    plugins: [{
      name: "storage-route-billing-stub",
      setup(builder) {
        // Only the storage route's Stripe lookup is replaced.
        builder.onResolve({ filter: /\/lib\/billing$/ }, (args) =>
          path.resolve(args.importer) === storageRoute ? { path: billingStub } : undefined);
      },
    }],
  });
  t = await import(outfile);
  server = await t.startServer();
  await main(server.base);
} finally {
  if (server) await server.close();
  await rm(outDir, { recursive: true, force: true });
}

console.log(`\nstorage metering: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
process.exit(0);
