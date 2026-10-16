// Shared public-link rate limits (publicLinkRateLimits in src/lib/loginRateLimit.ts)
// against real PostgreSQL. Run through the disposable-database harness only:
//   pnpm --filter @workspace/api-server run test:public-link-rate-limit
//
// Each "API instance" is a worker thread with its own module instance,
// connection pool and HTTP server, mounting the production middleware. It proves:
//   - per-link and per-IP quotas aggregate across two instances
//   - counters survive an instance restart for the rest of the window
//   - concurrent requests across instances never exceed the quota (no deadlock)
//   - expired counters are deleted and the next request opens a fresh window
//   - only HMACed keys are stored: no raw token, fingerprint or IP
//   - a failing or slow store falls back to per-process limits, never unlimited
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (!isMainThread) {
  const runtime = await import(workerData.bundle);
  runtime.configureProductionLoginRateLimitStore(runtime.createDatabaseLoginRateLimitStore());
  const app = runtime.express();
  app.set("trust proxy", 1);
  app.use("/link", runtime.publicLinkRateLimits, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1", () => {
    parentPort.postMessage({ port: server.address().port });
  });
  parentPort.once("message", () => {
    server.close(() => { void runtime.pool.end().then(() => parentPort.postMessage({ closed: true })); });
  });
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
  process.env.SESSION_SECRET = `public-link-rate-limit-test-${randomBytes(16).toString("hex")}`;

  const temp = await mkdtemp(fileURLToPath(new URL(".build-public-link-rate-limit-", import.meta.url)));
  const bundlePath = `${temp}/runtime.mjs`;
  await build({
    entryPoints: [fileURLToPath(new URL("./public-link-rate-limit-postgres.entry.ts", import.meta.url))],
    outfile: bundlePath,
    bundle: true, platform: "node", format: "esm",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  const bundle = pathToFileURL(bundlePath).href;
  const runtime = await import(bundle);
  const { pool } = runtime;

  const workers = new Set();
  async function instance() {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { bundle }, env: process.env });
    const port = await new Promise((resolve, reject) => {
      worker.once("message", (message) => resolve(message.port));
      worker.once("error", reject);
    });
    workers.add(worker);
    return {
      port,
      async stop() {
        const closed = new Promise((resolve) => worker.once("message", resolve));
        worker.postMessage("stop");
        await closed;
        await worker.terminate();
        workers.delete(worker);
      },
    };
  }

  const hits = (target, token, ip) => fetch(`http://127.0.0.1:${target.port}/link/${token}/info`, {
    headers: { "X-Forwarded-For": ip },
    signal: AbortSignal.timeout(10_000),
  }).then(async (response) => ({ status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.text() }));
  const hmac = (key) => createHmac("sha256", process.env.SESSION_SECRET).update(key).digest("hex");
  const tokenKey = (token) => hmac(`public-link-token:token:${createHash("sha256").update(token).digest("hex")}`);
  const ipKey = (ip) => hmac(`public-link:ip:${ip}`);
  // Every token and IP a test uses is tracked so its counters are deleted after.
  const fixtureKeys = new Set();
  const newToken = () => { const token = randomBytes(24).toString("hex"); fixtureKeys.add(tokenKey(token)); return token; };
  let ipCounter = 0;
  const newIp = () => {
    ipCounter += 1;
    const ip = `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
    fixtureKeys.add(ipKey(ip));
    return ip;
  };

  after(async () => {
    for (const worker of workers) await worker.terminate();
    if (fixtureKeys.size) {
      await pool.query("DELETE FROM auth_rate_limit_counters WHERE key_hash = ANY($1)", [[...fixtureKeys]]);
      const left = await pool.query("SELECT count(*)::int AS n FROM auth_rate_limit_counters WHERE key_hash = ANY($1)", [[...fixtureKeys]]);
      assert.equal(left.rows[0].n, 0, "fixture counters removed");
    }
    await pool.end();
    await rm(temp, { recursive: true, force: true });
  });

  const a = await instance();
  let b = await instance();

  test("one link's quota is shared across instances and survives a restart", async () => {
    const token = newToken();
    for (let i = 0; i < 60; i += 1) {
      const ip = newIp();
      const response = await hits(i % 2 ? b : a, token, ip);
      assert.equal(response.status, 200, `attempt ${i + 1}`);
    }
    for (const target of [a, b]) {
      const ip = newIp();
      const blocked = await hits(target, token, ip);
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.retryAfter) >= 1 && Number(blocked.retryAfter) <= 60);
    }
    await b.stop();
    b = await instance();
    const ip = newIp();
    assert.equal((await hits(b, token, ip)).status, 429, "restarted instance still sees the used quota");
    const other = newToken();
    assert.equal((await hits(b, other, ip)).status, 200, "a different link has its own quota");
  });

  test("one source IP's quota is shared across instances and links", async () => {
    const ip = newIp();
    for (let i = 0; i < 120; i += 1) {
      const token = newToken();
      assert.equal((await hits(i % 2 ? a : b, token, ip)).status, 200, `attempt ${i + 1}`);
    }
    const token = newToken();
    assert.equal((await hits(a, token, ip)).status, 429);
    assert.equal((await hits(b, token, ip)).status, 429);
    const fresh = newIp();
    assert.equal((await hits(b, token, fresh)).status, 200, "another IP is unaffected");
  });

  test("concurrent requests across instances never exceed one link's quota", async () => {
    const token = newToken();
    const responses = await Promise.all(Array.from({ length: 150 }, (_, i) => {
      const ip = newIp();
      return hits(i % 2 ? a : b, token, ip);
    }));
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 200).length, 60);
    assert.equal(statuses.filter((status) => status === 429).length, 90);
  });

  test("stores only HMACed keys, and expired counters are cleaned up", async () => {
    const token = newToken();
    const ip = newIp();
    assert.equal((await hits(a, token, ip)).status, 200);
    const fingerprint = createHash("sha256").update(token).digest("hex");
    const leaked = await pool.query(
      "SELECT count(*)::int AS n FROM auth_rate_limit_counters WHERE key_hash LIKE ANY($1)",
      [[`%${token}%`, `%${fingerprint}%`, `%${ip}%`]],
    );
    assert.equal(leaked.rows[0].n, 0);
    const rows = await pool.query("SELECT key_hash, attempts FROM auth_rate_limit_counters WHERE key_hash = ANY($1)", [[tokenKey(token), ipKey(ip)]]);
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.key_hash) && row.attempts === 1));

    // Use up the link, then expire its window: cleanup deletes it, and the
    // next request starts a new window at one attempt.
    for (let i = 1; i < 60; i += 1) await hits(i % 2 ? b : a, token, newIp());
    const blockedIp = newIp();
    assert.equal((await hits(a, token, blockedIp)).status, 429);
    await pool.query("UPDATE auth_rate_limit_counters SET expires_at = clock_timestamp() - interval '1 second' WHERE key_hash = $1", [tokenKey(token)]);
    assert.ok(await runtime.deleteExpiredRateLimitCounters() >= 1);
    const gone = await pool.query("SELECT count(*)::int AS n FROM auth_rate_limit_counters WHERE key_hash = $1", [tokenKey(token)]);
    assert.equal(gone.rows[0].n, 0);
    assert.equal((await hits(b, token, blockedIp)).status, 200);
    const reopened = await pool.query("SELECT attempts FROM auth_rate_limit_counters WHERE key_hash = $1", [tokenKey(token)]);
    assert.equal(reopened.rows[0].attempts, 1);
  });

  test("a failing or slow store falls back to per-process limits", async () => {
    const stores = {
      failing: { async consume() { throw new Error("down"); }, async consumeMany() { throw new Error("down"); } },
      slow: { async consume() { return new Promise(() => {}); }, async consumeMany() { return new Promise(() => {}); } },
      invalid: { async consume() { return { count: 0, retryAfterSeconds: 0 }; }, async consumeMany() { return []; } },
    };
    for (const [name, store] of Object.entries(stores)) {
      const limiter = runtime.makePublicLinkRateLimit([
        { namespace: `fallback-${name}`, windowMs: 60_000, max: 3, key: () => "same" },
      ], store);
      const outcomes = [];
      for (let i = 0; i < 5; i += 1) {
        outcomes.push(await new Promise((resolve) => {
          const res = {
            headers: {},
            setHeader(key, value) { this.headers[key] = value; },
            status(code) { resolve(code); return { json() {} }; },
          };
          void limiter({ path: "/x", ip: "203.0.113.9", headers: {}, log: { warn() {} } }, res, () => resolve(200));
        }));
      }
      assert.deepEqual(outcomes, [200, 200, 200, 429, 429], name);
    }
  });
}
