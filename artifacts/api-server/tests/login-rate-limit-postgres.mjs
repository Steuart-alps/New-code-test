// PostgreSQL regression test for the shared sign-in / registration counters
// (src/lib/loginRateLimitStore.ts) used by production API instances.
//
// Run through the disposable-database harness only:
//   bash tests/run-fresh-schema.sh tests/login-rate-limit-postgres.mjs
//
// It proves, against real PostgreSQL built from runtime migrations:
//   - concurrent consumes from two independent "API instances" (worker
//     threads, each with its own module instance and connection pool) return
//     one distinct count per allowed attempt and cap every later count at max+1
//   - an expired window resets atomically to exactly one new window starting
//     at count 1, even under concurrency
//   - the real production login (15 min / 10) and registration (1 h / 5)
//     middleware keep their windows: later attempts never extend expiry
//
// Fixture keys use a synthetic SESSION_SECRET and per-run unique keys; every
// row this test creates is deleted afterwards and that deletion is verified.

import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;

if (!isMainThread) {
  // One simulated API instance: its own bundle import, pool and store.
  const runtime = await import(workerData.bundle);
  const store = runtime.createDatabaseLoginRateLimitStore();
  parentPort.once("message", async () => {
    try {
      const results = await Promise.all(Array.from({ length: workerData.attempts }, () =>
        store.consume(workerData.key, workerData.windowMs, workerData.max)));
      parentPort.postMessage({ results });
    } catch (error) {
      parentPort.postMessage({ error: String(error?.stack ?? error) });
    } finally {
      await runtime.pool.end();
    }
  });
  parentPort.postMessage({ ready: true });
} else {
  await main();
}

async function main() {
  const { default: test, after } = await import("node:test");
  if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
      || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
    throw new Error("Run via tests/run-fresh-schema.sh: this test needs the disposable database.");
  }
  // Synthetic per-run key; never a deployment secret.
  process.env.SESSION_SECRET = `login-rate-limit-pg-test-${randomBytes(16).toString("hex")}`;

  const temp = await mkdtemp(fileURLToPath(new URL(".build-login-rate-limit-pg-", import.meta.url)));
  const bundlePath = `${temp}/runtime.mjs`;
  await build({
    entryPoints: [fileURLToPath(new URL("./login-rate-limit-postgres.entry.ts", import.meta.url))],
    outfile: bundlePath,
    bundle: true, platform: "node", format: "esm",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  const bundleUrl = pathToFileURL(bundlePath).href;
  const runtime = await import(bundleUrl);
  const { pool } = runtime;

  const runId = randomUUID();
  const fixtureHashes = new Set();
  const hashKey = (key) => {
    const hash = createHmac("sha256", process.env.SESSION_SECRET).update(key).digest("hex");
    fixtureHashes.add(hash);
    return hash;
  };
  const isolatedKey = (label) => {
    const key = `${label}:ip:pg-test-${runId}-${randomUUID()}`;
    hashKey(key);
    return key;
  };
  const counterRow = async (key) => (await pool.query(`
    SELECT attempts,
      EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))::float8 AS remaining_seconds,
      expires_at::text AS expires_at
    FROM auth_rate_limit_counters WHERE key_hash = $1
  `, [hashKey(key)])).rows[0];

  after(async () => {
    try {
      await pool.query("DELETE FROM auth_rate_limit_counters WHERE key_hash = ANY($1::text[])", [[...fixtureHashes]]);
      const left = await pool.query(
        "SELECT count(*)::int AS n FROM auth_rate_limit_counters WHERE key_hash = ANY($1::text[])",
        [[...fixtureHashes]],
      );
      assert.equal(left.rows[0].n, 0, "fixture counters must be removed");
    } finally {
      await pool.end();
      await rm(temp, { recursive: true, force: true });
    }
  });

  /** Fire `attemptsPerInstance` simultaneous consumes from each of two instances. */
  async function consumeFromTwoInstances(key, windowMs, max, attemptsPerInstance) {
    const workers = [0, 1].map(() => new Worker(new URL(import.meta.url), {
      workerData: { bundle: bundleUrl, key, windowMs, max, attempts: attemptsPerInstance },
    }));
    try {
      const ready = workers.map((worker) => new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", resolve);
      }));
      await Promise.all(ready);
      const done = workers.map((worker) => new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (message) => message.error ? reject(new Error(message.error)) : resolve(message.results));
      }));
      // Release both instances together so their upserts overlap.
      for (const worker of workers) worker.postMessage("go");
      return (await Promise.all(done)).flat();
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }

  function assertCappedSequence(results, max, label) {
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    const allowed = counts.filter((c) => c <= max);
    assert.deepEqual(allowed, Array.from({ length: max }, (_, i) => i + 1),
      `${label}: each allowed attempt must receive a distinct count 1..max`);
    assert.ok(counts.slice(max).every((c) => c === max + 1),
      `${label}: every attempt past the limit must be capped at max+1, got ${counts.join(",")}`);
    assert.equal(Math.max(...counts), max + 1, `${label}: returned count must never exceed max+1`);
  }

  test("concurrent login attempts from two instances cap at max+1", async () => {
    const key = isolatedKey("login");
    const results = await consumeFromTwoInstances(key, LOGIN_WINDOW_MS, 10, 20);
    assert.equal(results.length, 40);
    assertCappedSequence(results, 10, "login");
    const row = await counterRow(key);
    assert.equal(row.attempts, 11);
    for (const r of results) {
      assert.ok(r.retryAfterSeconds > 15 * 60 - 30 && r.retryAfterSeconds <= 15 * 60,
        `login retry-after must reflect the 15-minute window, got ${r.retryAfterSeconds}`);
    }
  });

  test("concurrent registration attempts from two instances cap at max+1", async () => {
    const key = isolatedKey("register");
    const results = await consumeFromTwoInstances(key, REGISTRATION_WINDOW_MS, 5, 12);
    assert.equal(results.length, 24);
    assertCappedSequence(results, 5, "registration");
    assert.equal((await counterRow(key)).attempts, 6);
    for (const r of results) {
      assert.ok(r.retryAfterSeconds > 60 * 60 - 30 && r.retryAfterSeconds <= 60 * 60,
        `registration retry-after must reflect the one-hour window, got ${r.retryAfterSeconds}`);
    }
  });

  for (const [label, windowMs, max] of [["login", LOGIN_WINDOW_MS, 10], ["register", REGISTRATION_WINDOW_MS, 5]]) {
    test(`${label}: an expired window resets to one under concurrency`, async () => {
      const key = isolatedKey(label);
      const first = await consumeFromTwoInstances(key, windowMs, max, max + 3);
      assertCappedSequence(first, max, `${label} before expiry`);
      // Age the fixture's window into the past; only this run's key is touched.
      const expired = await pool.query(
        "UPDATE auth_rate_limit_counters SET expires_at = clock_timestamp() - interval '1 second' WHERE key_hash = $1",
        [hashKey(key)],
      );
      assert.equal(expired.rowCount, 1);

      const afterExpiry = await consumeFromTwoInstances(key, windowMs, max, max + 3);
      assertCappedSequence(afterExpiry, max, `${label} after expiry`);
      assert.equal(afterExpiry.filter((r) => r.count === 1).length, 1,
        "exactly one attempt opens the new window");
      const row = await counterRow(key);
      assert.equal(row.attempts, max + 1);
      const windowSeconds = windowMs / 1000;
      assert.ok(row.remaining_seconds > windowSeconds - 30 && row.remaining_seconds <= windowSeconds,
        `new window must be a full ${windowSeconds}s, got ${row.remaining_seconds}`);
    });
  }

  test("real production login and registration limiters retain their windows", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    runtime.configureProductionLoginRateLimitStore(runtime.createDatabaseLoginRateLimitStore());
    const express = (await import("express")).default;
    const app = express();
    app.set("trust proxy", 1);
    app.post("/login", runtime.loginRateLimit, (_req, res) => res.status(401).json({ error: "bad" }));
    app.post("/register", runtime.registrationRateLimit, (_req, res) => res.status(201).json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const post = async (path, ip) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: { "x-forwarded-for": ip },
      });
      await response.arrayBuffer();
      return { status: response.status, retryAfter: Number(response.headers.get("retry-after")) };
    };
    try {
      // Unique documentation-range IPv6 address per run keeps keys isolated.
      const ip = `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
      const loginKey = `login:ip:${ip}`;
      const registerKey = `register:ip:${ip}`;
      hashKey(loginKey);
      hashKey(registerKey);

      for (const [path, key, max, windowSeconds] of [
        ["/login", loginKey, 10, 15 * 60],
        ["/register", registerKey, 5, 60 * 60],
      ]) {
        const statuses = await Promise.all(Array.from({ length: max + 4 }, () => post(path, ip)));
        assert.equal(statuses.filter((s) => s.status !== 429).length, max,
          `${path}: exactly ${max} concurrent attempts pass the shared limit`);
        const opened = await counterRow(key);
        assert.equal(opened.attempts, max + 1);
        assert.ok(opened.remaining_seconds > windowSeconds - 30 && opened.remaining_seconds <= windowSeconds,
          `${path}: window is ${windowSeconds}s, got ${opened.remaining_seconds}`);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const blocked = await post(path, ip);
        assert.equal(blocked.status, 429);
        assert.ok(blocked.retryAfter > windowSeconds - 60 && blocked.retryAfter < windowSeconds,
          `${path}: Retry-After counts down within the original window, got ${blocked.retryAfter}`);
        const retained = await counterRow(key);
        assert.equal(retained.expires_at, opened.expires_at, `${path}: later attempts must not extend the window`);
        assert.equal(retained.attempts, max + 1);
      }
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
