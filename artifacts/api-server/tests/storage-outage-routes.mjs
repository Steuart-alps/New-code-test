import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required; use run-storage-outage-routes.sh");
const EXPECTED = {
  error: "File uploads are temporarily unavailable. Please try again later.",
  code: "OBJECT_STORAGE_UNAVAILABLE",
};
const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-storage-outage-"));
const runId = resolveRunId();
const fixtures = createFixtureOwnership({ runId, suite: "storage-outage-routes" });
let db, pool, sql, clientId;

// Generic provider vocabulary must never reach a response body; the fault's own
// message (objectStorage.ts) must not appear in the body or any header.
const FORBIDDEN_BODY_WORDS = ["detail", "stack", "credential", "bucket", "TEST_ONLY_PROVIDER"];
const FAULT_FRAGMENTS = ["TEST_ONLY_PROVIDER", "CREDENTIAL_SECRET", "bucket-internal-name"];

function session() {
  let cookie = "";
  return async (method, route, body) => {
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return readResponse(response);
  };
}

async function publicRequest(method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readResponse(response);
}

async function readResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, text, headers: [...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n") };
}

/** Every way `response` breaks the safe outage contract; empty when it holds. */
function outageProblems(response) {
  const problems = [];
  const body = response.text.toLowerCase();
  const leakedWords = FORBIDDEN_BODY_WORDS.filter((word) => body.includes(word.toLowerCase()));
  if (leakedWords.length) problems.push(`LEAK: body mentions ${leakedWords.join(", ")}`);
  const leakedFault = FAULT_FRAGMENTS.filter((f) => response.headers.toLowerCase().includes(f.toLowerCase()));
  if (leakedFault.length) problems.push(`LEAK: headers carry the provider error (${leakedFault.join(", ")})`);
  if (response.status !== 503) problems.push(`CONTRACT: status ${response.status}, expected 503`);
  if (!isDeepStrictEqual(response.data, EXPECTED)) problems.push("CONTRACT: body is not exactly the stable outage response");
  return problems;
}

try {
  const outfile = path.join(outDir, "db.mjs");
  await build({
    entryPoints: [path.join(dir, "storage-outage-routes.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);" },
  });
  ({ db, pool, sql } = await import(outfile));

  const request = session();
  const email = `storage-outage-${runId}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: "Storage outage test", email, password: "password-123",
  });
  assert.ok([200, 201].includes(registered.status), "register");
  fixtures.trackRegisteredUser();
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200, "verify");
  assert.equal((await request("POST", "/auth/login", { email, password: "password-123" })).status, 200, "login");
  const me = await request("GET", "/auth/me");
  clientId = me.data?.user?.clientId ?? me.data?.client?.id;
  assert.ok(Number.isInteger(clientId), "client context");
  fixtures.trackClient(clientId);

  const site = await request("POST", "/sites", { name: "Storage outage site", seedStarterChecks: false });
  assert.equal(site.status, 201, "create site");
  const risk = await request("POST", "/safe-track/risk-assessments", { title: "Storage outage risk" });
  assert.equal(risk.status, 201, "create photo entity");
  const issue = await request("POST", "/fix-track/issues", {
    title: "Storage outage issue",
    location: "Plant room",
    reportedBy: "Test",
    reportedDate: new Date().toISOString().slice(0, 10),
  });
  assert.equal(issue.status, 201, "create FixTrack issue");
  const contractor = await request("POST", "/contractors", {
    name: "Storage outage contractor",
    email: `storage-contractor-${Date.now()}@test.local`,
  });
  assert.equal(contractor.status, 201, "create contractor");
  const portal = await request("POST", `/contractors/${contractor.data.id}/portal-link`, {});
  assert.equal(portal.status, 201, "issue contractor portal token");

  const actionToken = crypto.randomBytes(32).toString("hex");
  const actionHash = crypto.createHash("sha256").update(actionToken).digest("hex");
  await db.execute(sql`
    INSERT INTO fix_track_action_tokens
      (token_hash, issue_id, client_id, contractor_id, action, expires_at)
    VALUES
      (${actionHash}, ${issue.data.id}, ${clientId}, ${contractor.data.id}, 'completed', now() + interval '1 day')
  `);

  const routes = [
    ["generic documents", () => request("POST", "/storage/uploads/request-url", { name: "a.pdf", size: 1, contentType: "application/pdf" })],
    ["site documents", () => request("POST", `/sites/${site.data.id}/documents/request-upload`, {})],
    ["DocTrack", () => request("POST", "/doc-track/documents/request-upload", { name: "a.pdf", contentType: "application/pdf" })],
    ["SafeTrack", () => request("POST", "/safe-track/request-upload", {})],
    ["photos", () => request("POST", "/photos/request-upload", {
      entityType: "safe_risk_assessment", entityId: risk.data.id, name: "a.png", contentType: "image/png",
    })],
    ["FixTrack", () => request("POST", `/fix-track/issues/${issue.data.id}/request-upload`, {
      name: "a.jpg", contentType: "image/jpeg",
    })],
    ["public FixTrack", () => publicRequest("POST", `/fix-track/action/${actionToken}/upload-url`, {})],
    ["contractor portal", () => publicRequest("POST", `/contractor-portal/${portal.data.token}/upload-url`, {
      contentType: "application/pdf",
    })],
  ];
  const failures = [];
  for (const [name, call] of routes) {
    const response = await call();
    const problems = outageProblems(response);
    if (problems.length) failures.push({ name, problems, response });
  }

  // Signing must stay behind authentication, validation and ownership checks.
  const guards = [
    ["authentication still precedes signing", 401, () => publicRequest("POST", "/storage/uploads/request-url", {
      name: "a.pdf", size: 1, contentType: "application/pdf",
    })],
    ["request validation still precedes signing", 400, () => publicRequest("POST", `/contractor-portal/${portal.data.token}/upload-url`, {
      contentType: "text/html",
    })],
    ["resource ownership still precedes signing", 404, () => request("POST", "/photos/request-upload", {
      entityType: "safe_risk_assessment", entityId: 2147483647, name: "a.png", contentType: "image/png",
    })],
    ["invalid public token still fails normally", 400, () => publicRequest("POST", "/fix-track/action/not-a-valid-token/upload-url", {})],
  ];
  const guardFailures = [];
  for (const [name, expectedStatus, call] of guards) {
    const { status, text } = await call();
    if (status !== expectedStatus) guardFailures.push(`  - ${name}: status ${status}, expected ${expectedStatus}; received ${text.slice(0, 200)}`);
  }

  if (failures.length || guardFailures.length) {
    const report = failures.map(({ name, problems, response }) =>
      `  - ${name}:\n${problems.map((p) => `      ${p}`).join("\n")}\n      received: ${response.status} ${response.text.slice(0, 500)}`);
    console.error([
      `STORAGE OUTAGE CONTRACT FAILED: ${failures.length} of ${routes.length} upload routes unsafe, ${guardFailures.length} of ${guards.length} pre-signing checks changed.`,
      ...report,
      ...(failures.length ? [`  expected: 503 ${JSON.stringify(EXPECTED)}`] : []),
      ...guardFailures,
      "Answer signing failures with respondObjectStorageUnavailable (src/lib/objectStorageUnavailable.ts); never forward provider error text.",
    ].join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`${routes.length} upload routes returned the exact safe storage outage contract`);
  }
} finally {
  // Removes this run's tenant and everything referencing it, audit rows included.
  await fixtures.cleanup().catch((error) => {
    console.error(`storage-outage-routes: fixture cleanup failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
  await pool?.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}