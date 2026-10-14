// Trial-lock middleware allowlist (no database, no server). The real
// enforceTrialLock runs with the lock decision stubbed to "locked":
//  - a consultant's read-only GET /portfolio passes through, so the list of
//    businesses they manage keeps working after their own trial has ended;
//  - every other data route, and any non-GET /portfolio request, still gets
//    402 trial_expired; billing and auth stay open as before.
// Usage: node tests/trial-lock-allowlist.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const outDir = await mkdtemp(path.join(testsDir, ".build-trial-lock-allowlist-"));
const outFile = path.join(outDir, "trial-lock.mjs");

const stubs = {
  requireAuth: "export const getClientId = (req) => req.selectedClientId ?? null;",
  trialLock: "export const isClientBillingLocked = async () => true;",
  logger: "export const logger = { error() {}, warn() {}, info() {} };",
};

try {
  await build({
    entryPoints: [path.join(apiDir, "src/middleware/trialLock.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    plugins: [{
      name: "trial-lock-stubs",
      setup(builder) {
        for (const [filter, name] of [
          [/\/requireAuth$/, "requireAuth"],
          [/\/lib\/trialLock$/, "trialLock"],
          [/\/lib\/logger$/, "logger"],
        ]) {
          builder.onResolve({ filter }, () => ({ path: name, namespace: "trial-lock-test" }));
        }
        builder.onLoad({ filter: /.*/, namespace: "trial-lock-test" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
      },
    }],
  });
  const { enforceTrialLock } = await import(pathToFileURL(outFile).href);

  async function run(method, reqPath) {
    let status = 200;
    let body = null;
    let passed = false;
    const req = { method, path: reqPath, currentUser: { id: 1, role: "consultant" }, selectedClientId: 7 };
    const res = {
      status(code) { status = code; return this; },
      json(value) { body = value; return this; },
    };
    await enforceTrialLock(req, res, () => { passed = true; });
    return { passed, status, body };
  }

  const portfolio = await run("GET", "/portfolio");
  assert.equal(portfolio.passed, true, "GET /portfolio is allowed through the trial lock");

  for (const [method, reqPath] of [
    ["GET", "/dashboard/summary"],
    ["GET", "/sites"],
    ["POST", "/portfolio"],
    ["GET", "/portfolio/extra"],
    ["GET", "/consultant-branding"],
    ["PUT", "/consultant-branding"],
  ]) {
    const result = await run(method, reqPath);
    assert.equal(result.passed, false, `${method} ${reqPath} stays locked`);
    assert.equal(result.status, 402, `${method} ${reqPath} returns 402`);
    assert.equal(result.body?.code, "trial_expired");
  }
  for (const reqPath of ["/auth/me", "/billing/config", "/healthz"]) {
    assert.equal((await run("GET", reqPath)).passed, true, `${reqPath} stays open`);
  }
  console.log("Trial lock allowlist checks passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
