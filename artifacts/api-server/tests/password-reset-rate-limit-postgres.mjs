// PostgreSQL test for the production reset-password limiter
// (resetPasswordRateLimit in src/lib/loginRateLimit.ts with the shared store in
// src/lib/loginRateLimitStore.ts).
//
// Run through the disposable-database harness only:
//   bash tests/run-fresh-schema.sh tests/password-reset-rate-limit-postgres.mjs
//
// Two "API instances" are separate module instances of the real limiter, each
// with its own connection pool and store, mounted in front of a stub reset
// handler (400 invalid link, 401 unauthorized, 200 success). It checks the
// 10-failure / 15-minute cap across instances, that successful resets are not
// counted, that concurrent guesses can never exceed the cap, that a database
// outage answers 503 without running the handler, and that development
// (non-production) stays in-memory. Fixture keys use a synthetic secret and
// unique documentation-range IPs, and are deleted afterwards.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { build } from "esbuild";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("Run via tests/run-fresh-schema.sh: this test needs the disposable database.");
}
process.env.SESSION_SECRET = `reset-limit-pg-test-${randomBytes(16).toString("hex")}`;

const temp = await mkdtemp(fileURLToPath(new URL(".build-reset-limit-pg-", import.meta.url)));
const bundlePath = `${temp}/runtime.mjs`;
await build({
  entryPoints: [fileURLToPath(new URL("./password-reset-rate-limit-postgres.entry.ts", import.meta.url))],
  outfile: bundlePath,
  bundle: true, platform: "node", format: "esm",
  external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
  banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
});
// A distinct query string gives each simulated API instance its own module
// state: its own pool, store and configured production limiter.
const instance = async (name) => {
  const runtime = await import(`${pathToFileURL(bundlePath).href}?instance=${name}`);
  runtime.configureProductionLoginRateLimitStore(runtime.createDatabaseLoginRateLimitStore());
  return runtime;
};
const nodeA = await instance("a");
const nodeB = await instance("b");
const nodeDown = await instance("down");
await nodeDown.pool.end(); // A real outage: this instance cannot reach PostgreSQL.

let handlerCalls = 0;
const resetHandler = (req, res) => {
  handlerCalls++;
  const token = req.get("x-token");
  if (token === "valid") res.json({ ok: true });
  else if (token === "unauthorized") res.status(401).json({ error: "unauthorized" });
  else res.status(400).json({ error: "This reset link is invalid or has expired." });
};
const app = express();
app.set("trust proxy", 1);
app.post("/a", nodeA.resetPasswordRateLimit, resetHandler);
app.post("/b", nodeB.resetPasswordRateLimit, resetHandler);
app.post("/down", nodeDown.resetPasswordRateLimit, resetHandler);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const fixtureHashes = new Set();
const freshIp = () => {
  const ip = `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
  fixtureHashes.add(createHmac("sha256", process.env.SESSION_SECRET).update(`reset-password:ip:${ip}`).digest("hex"));
  return ip;
};
const hashFor = (ip) => createHmac("sha256", process.env.SESSION_SECRET).update(`reset-password:ip:${ip}`).digest("hex");
const counter = async (ip) => (await nodeA.pool.query(`
  SELECT attempts, EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))::float8 AS remaining_seconds
  FROM auth_rate_limit_counters WHERE key_hash = $1
`, [hashFor(ip)])).rows[0];
async function waitForAttempts(ip, expected) {
  for (let i = 0; i < 100; i++) {
    if (((await counter(ip))?.attempts ?? 0) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`counter for ${ip} did not settle at ${expected}`);
}
async function post(path, ip, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "x-forwarded-for": ip, "x-token": token },
  });
  await response.arrayBuffer();
  return { status: response.status, retryAfter: Number(response.headers.get("retry-after")) };
}

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";

after(async () => {
  process.env.NODE_ENV = previousNodeEnv;
  await new Promise((resolve) => server.close(resolve));
  try {
    await nodeA.pool.query("DELETE FROM auth_rate_limit_counters WHERE key_hash = ANY($1::text[])", [[...fixtureHashes]]);
    const left = await nodeA.pool.query(
      "SELECT count(*)::int AS n FROM auth_rate_limit_counters WHERE key_hash = ANY($1::text[])", [[...fixtureHashes]]);
    assert.equal(left.rows[0].n, 0, "fixture counters must be removed");
  } finally {
    await nodeA.pool.end();
    await nodeB.pool.end();
    await rm(temp, { recursive: true, force: true });
  }
});

test("invalid and unauthorized reset attempts share one 10-per-15-minute cap across instances", async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i++) {
    assert.equal((await post("/a", ip, `guess-${i}`)).status, 400);
    assert.equal((await post("/b", ip, "unauthorized")).status, 401);
  }
  const blockedA = await post("/a", ip, "guess-x");
  const blockedB = await post("/b", ip, "valid");
  assert.equal(blockedA.status, 429);
  assert.equal(blockedB.status, 429, "even a valid link is refused once the source IP is limited");
  assert.ok(blockedA.retryAfter > 15 * 60 - 30 && blockedA.retryAfter <= 15 * 60, `Retry-After ${blockedA.retryAfter}`);
  const row = await counter(ip);
  assert.equal(row.attempts, 11);
  assert.ok(row.remaining_seconds > 15 * 60 - 30 && row.remaining_seconds <= 15 * 60);
});

test("successful resets are not counted", async () => {
  const ip = freshIp();
  for (let i = 0; i < 9; i++) assert.equal((await post(i % 2 ? "/a" : "/b", ip, `guess-${i}`)).status, 400);
  await waitForAttempts(ip, 9);
  for (let i = 0; i < 12; i++) {
    assert.equal((await post(i % 2 ? "/a" : "/b", ip, "valid")).status, 200, `success ${i}`);
    await waitForAttempts(ip, 9); // the reservation is handed back after the response
  }
  assert.equal((await post("/b", ip, "guess-9")).status, 400, "tenth failure is still answered");
  assert.equal((await post("/a", ip, "guess-10")).status, 429);
});

test("a success with no prior failures leaves no counter behind", async () => {
  const ip = freshIp();
  assert.equal((await post("/a", ip, "valid")).status, 200);
  for (let i = 0; i < 100 && await counter(ip); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await counter(ip), undefined, "the next failure opens a fresh 15-minute window");
});

test("concurrent guesses across instances never exceed the cap", async () => {
  const ip = freshIp();
  const before = handlerCalls;
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => post(i % 2 ? "/a" : "/b", ip, `c-${i}`)));
  assert.equal(results.filter((r) => r.status === 400).length, 10, results.map((r) => r.status).join(","));
  assert.equal(results.filter((r) => r.status === 429).length, 30);
  assert.equal(handlerCalls - before, 10);
});

test("shared-store outage answers 503 without running the reset handler", async () => {
  const before = handlerCalls;
  const result = await post("/down", freshIp(), "valid");
  assert.equal(result.status, 503);
  assert.equal(handlerCalls, before);
});

test("development keeps the in-memory limiter and writes no shared counter", async () => {
  process.env.NODE_ENV = "development";
  try {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) assert.equal((await post("/a", ip, `dev-${i}`)).status, 400);
    assert.equal((await post("/a", ip, "dev-10")).status, 429);
    assert.equal((await post("/down", freshIp(), "valid")).status, 200, "no database needed in development");
    assert.equal(await counter(ip), undefined);
  } finally {
    process.env.NODE_ENV = "production";
  }
});
