// Bounded Stripe start-up: /readyz states and billing activation gating for
// unconfigured, slow, hung, failing and recovering Stripe dependencies.
// Uses fakes and short timers only — never contacts Stripe or a connector.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-stripe-startup-"));
const outFile = path.join(outDir, "stripe-startup-readiness.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(5);
  }
}

function captureLogger() {
  const lines = [];
  const at = (level) => (obj, msg) => lines.push({ level, obj, msg });
  return { lines, logger: { info: at("info"), warn: at("warn"), error: at("error") } };
}

// Scrub any inherited Stripe/connector configuration before loading the code.
for (const key of ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "REPLIT_CONNECTORS_HOSTNAME", "REPL_IDENTITY", "WEB_REPL_RENEWAL"]) {
  delete process.env[key];
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  await build({
    entryPoints: [path.join(testsDir, "stripe-startup-readiness.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["stripe", "stripe-replit-sync", "pg-native"],
  });
  const m = await import(pathToFileURL(outFile).href);
  const readyz = () => m.computeReadiness(true, m.getBillingReadiness());

  await test("core readiness comes first; isolated entry points without Stripe are ready", async () => {
    m.resetBillingReadinessForTests();
    assert.deepEqual(m.computeReadiness(false, m.getBillingReadiness()), { httpStatus: 503, body: { status: "starting" } });
    assert.deepEqual(readyz(), { httpStatus: 200, body: { status: "ok" } });
  });

  await test("credential source is detected without reading or requesting credentials", async () => {
    assert.equal(m.getStripeCredentialSource(), null);
    process.env.REPL_IDENTITY = "fake-identity";
    assert.equal(m.getStripeCredentialSource(), null, "a token without a connector host is not a usable configuration");
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connector.invalid";
    assert.equal(m.getStripeCredentialSource(), "replit-connector");
    process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_not_real";
    assert.equal(m.getStripeCredentialSource(), "env");
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.REPL_IDENTITY;
    delete process.env.REPLIT_CONNECTORS_HOSTNAME;
  });

  await test("connector credential request is bounded and its error names no token", async () => {
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connector.invalid";
    process.env.REPL_IDENTITY = "fake-identity-token-value";
    process.env.STRIPE_CONNECTOR_TIMEOUT_MS = "50";
    const realFetch = globalThis.fetch;
    let sawSignal = false;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      sawSignal = Boolean(init?.signal);
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
    });
    // AbortSignal.timeout() timers are unref'd; a real fetch's socket keeps the
    // process alive, so the stub needs an equivalent handle.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const started = Date.now();
      await assert.rejects(m.getStripeSecretKey(), (err) => {
        assert.match(err.message, /timed out after 50ms/);
        assert.doesNotMatch(err.message, /fake-identity-token-value/);
        return true;
      });
      assert.ok(Date.now() - started < 1_000, "the hung connector request must be abandoned at its deadline");
      assert.ok(sawSignal, "the connector request must carry an abort signal");
    } finally {
      clearInterval(keepAlive);
      globalThis.fetch = realFetch;
      delete process.env.REPLIT_CONNECTORS_HOSTNAME;
      delete process.env.REPL_IDENTITY;
      delete process.env.STRIPE_CONNECTOR_TIMEOUT_MS;
    }
  });

  await test("unconfigured outside production: ready, billing activation blocked, no attempt", async () => {
    m.resetBillingReadinessForTests();
    const { logger } = captureLogger();
    let attempts = 0;
    const handle = m.startStripeInitialization({
      credentialSource: () => null,
      runAttempt: async () => { attempts += 1; return { blocker: null, catalogueVerified: true }; },
      required: false, timeoutMs: 1_000, retryDelaysMs: [10], logger,
    });
    await handle.firstSettledOrDeadline;
    assert.equal(attempts, 0);
    assert.deepEqual(readyz(), {
      httpStatus: 200,
      body: { status: "ok", billing: { state: "unconfigured", activationBlocked: true } },
    });
    assert.equal(m.isBillingActivationAllowed(), false);
    handle.stop();
  });

  await test("unconfigured in production: degraded with a non-secret blocker", async () => {
    m.resetBillingReadinessForTests();
    const handle = m.startStripeInitialization({
      credentialSource: () => null,
      runAttempt: async () => ({ blocker: null, catalogueVerified: true }),
      required: true, timeoutMs: 1_000, retryDelaysMs: [10], logger: captureLogger().logger,
    });
    await handle.firstSettledOrDeadline;
    const report = readyz();
    assert.equal(report.httpStatus, 503);
    assert.equal(report.body.status, "degraded");
    assert.equal(report.body.blocker, m.STRIPE_NOT_CONFIGURED_BLOCKER);
    assert.equal(m.isBillingActivationAllowed(), false);
    handle.stop();
  });

  await test("slow Stripe: starting, then degraded at the deadline naming the step, then recovers", async () => {
    m.resetBillingReadinessForTests();
    const { lines, logger } = captureLogger();
    let release;
    let attempts = 0;
    let readyCalls = 0;
    const handle = m.startStripeInitialization({
      credentialSource: () => "env",
      runAttempt: async (onStage) => {
        attempts += 1;
        onStage("sync SDK import");
        onStage("credential lookup");
        await new Promise((resolve) => { release = resolve; });
        onStage("service-price catalogue");
        return { blocker: null, catalogueVerified: true };
      },
      required: true, timeoutMs: 60, retryDelaysMs: [10], logger,
      onCatalogueVerified: () => { readyCalls += 1; },
    });
    assert.equal(readyz().httpStatus, 503);
    assert.equal(readyz().body.status, "starting");
    assert.equal(m.isBillingActivationAllowed(), false, "activation is blocked while start-up runs");
    assert.equal(m.isStripeCatalogueVerified(), false, "reconciliation is held while start-up runs");

    let deadlineReached = false;
    void handle.firstSettledOrDeadline.then(() => { deadlineReached = true; });
    await waitFor(() => deadlineReached, "first-attempt deadline");
    const degraded = readyz();
    assert.equal(degraded.httpStatus, 503);
    assert.equal(degraded.body.status, "degraded");
    assert.match(degraded.body.blocker, /timed out during credential lookup/);
    assert.equal(degraded.body.billing.stage, "credential lookup");
    assert.equal(degraded.body.billing.retrying, true);
    assert.equal(m.isBillingActivationAllowed(), false);

    await sleep(80);
    assert.equal(attempts, 1, "a stalled attempt must not be duplicated by a concurrent retry");

    release();
    await waitFor(() => m.getBillingReadiness().phase === "ready", "recovery");
    assert.deepEqual(readyz(), { httpStatus: 200, body: { status: "ok", billing: { state: "ready", activationBlocked: false } } });
    assert.equal(readyCalls, 1);
    assert.ok(lines.some((l) => l.msg.includes("exceeded its deadline") && l.obj.stage === "credential lookup"));
    handle.stop();
  });

  await test("hung Stripe never leaves readiness on starting and is never retried concurrently", async () => {
    m.resetBillingReadinessForTests();
    let attempts = 0;
    const handle = m.startStripeInitialization({
      credentialSource: () => "replit-connector",
      runAttempt: async (onStage) => { attempts += 1; onStage("managed webhook"); return new Promise(() => {}); },
      required: false, timeoutMs: 30, retryDelaysMs: [5], logger: captureLogger().logger,
    });
    await handle.firstSettledOrDeadline;
    await sleep(60);
    const report = readyz();
    assert.equal(report.body.status, "degraded");
    assert.match(report.body.blocker, /managed webhook/);
    assert.equal(attempts, 1);
    assert.equal(m.isBillingActivationAllowed(), false);
    handle.stop();
  });

  await test("failing Stripe retries with back-off and recovers", async () => {
    m.resetBillingReadinessForTests();
    const { lines, logger } = captureLogger();
    let attempts = 0;
    const handle = m.startStripeInitialization({
      credentialSource: () => "env",
      runAttempt: async (onStage) => {
        attempts += 1;
        onStage("backfill sync");
        if (attempts === 1) throw new Error("synthetic connection reset");
        if (attempts === 2) return { blocker: "Stripe service-price catalogue could not be read", catalogueVerified: false };
        return { blocker: null, catalogueVerified: true };
      },
      required: true, timeoutMs: 1_000, retryDelaysMs: [10, 20], logger,
    });
    await handle.firstSettledOrDeadline;
    const first = readyz();
    assert.equal(first.httpStatus, 503);
    assert.equal(first.body.status, "degraded", "a failure reports degraded, not starting");
    assert.equal(first.body.blocker, m.STRIPE_INIT_FAILED_BLOCKER);
    assert.equal(m.isBillingActivationAllowed(), false);
    assert.equal(m.isStripeCatalogueVerified(), false);
    await waitFor(() => attempts === 2 && !m.getBillingReadiness().inFlight, "second attempt");
    assert.equal(readyz().body.status, "degraded", "a retry keeps reporting degraded rather than flapping to starting");
    await waitFor(() => m.getBillingReadiness().phase === "ready", "recovery after retries");
    assert.equal(readyz().httpStatus, 200);
    assert.equal(m.isBillingActivationAllowed(), true);
    assert.equal(lines.filter((l) => l.msg === "Stripe initialization will be retried").length, 2);
    handle.stop();
  });

  await test("verified catalogue gaps stay degraded, are not retried, and defer to per-request price checks", async () => {
    m.resetBillingReadinessForTests();
    let attempts = 0;
    let verifiedCalls = 0;
    const handle = m.startStripeInitialization({
      credentialSource: () => "env",
      runAttempt: async () => { attempts += 1; return { blocker: "Required Stripe service prices are missing", catalogueVerified: true }; },
      required: true, timeoutMs: 1_000, retryDelaysMs: [5], logger: captureLogger().logger,
      onCatalogueVerified: () => { verifiedCalls += 1; },
    });
    await handle.firstSettledOrDeadline;
    await sleep(40);
    assert.equal(attempts, 1);
    const report = readyz();
    assert.equal(report.httpStatus, 503);
    assert.equal(report.body.blocker, "Required Stripe service prices are missing");
    assert.equal(report.body.billing.retrying, false);
    assert.equal(m.isBillingActivationAllowed(), true, "the existing per-service preflight decides which services can be bought");
    assert.equal(m.isStripeCatalogueVerified(), true, "quantity reconciliation keeps running with a read catalogue");
    assert.equal(verifiedCalls, 1);
    handle.stop();
  });

  await test("timeout settings fall back safely", async () => {
    assert.equal(m.positiveMsFromEnv(undefined, 120_000), 120_000);
    assert.equal(m.positiveMsFromEnv("abc", 120_000), 120_000);
    assert.equal(m.positiveMsFromEnv("0", 120_000), 120_000);
    assert.equal(m.positiveMsFromEnv("5000", 120_000), 5_000);
  });

  console.log(`\n${passed} Stripe start-up readiness checks passed`);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
