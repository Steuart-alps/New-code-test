import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required; use run-storage-outage-routes.sh");
const EXPECTED = {
  error: "File uploads are temporarily unavailable. Please try again later.",
  code: "OBJECT_STORAGE_UNAVAILABLE",
};
const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-storage-outage-"));
let db, pool, sql, clientId;

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
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function publicRequest(method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

function assertSafeOutage(name, response) {
  assert.equal(response.status, 503, `${name}: status`);
  assert.deepEqual(response.data, EXPECTED, `${name}: exact safe response`);
  const serialized = JSON.stringify(response.data);
  for (const forbidden of ["detail", "stack", "credential", "bucket", "TEST_ONLY_PROVIDER"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `${name}: hides ${forbidden}`);
  }
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
  const email = `storage-outage-${Date.now()}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: "Storage outage test", email, password: "password-123",
  });
  assert.ok([200, 201].includes(registered.status), "register");
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200, "verify");
  assert.equal((await request("POST", "/auth/login", { email, password: "password-123" })).status, 200, "login");
  const me = await request("GET", "/auth/me");
  clientId = me.data?.user?.clientId ?? me.data?.client?.id;
  assert.ok(Number.isInteger(clientId), "client context");

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
  for (const [name, call] of routes) assertSafeOutage(name, await call());

  assert.equal((await publicRequest("POST", "/storage/uploads/request-url", {
    name: "a.pdf", size: 1, contentType: "application/pdf",
  })).status, 401, "authentication still precedes signing");
  assert.equal((await publicRequest("POST", `/contractor-portal/${portal.data.token}/upload-url`, {
    contentType: "text/html",
  })).status, 400, "request validation still precedes signing");
  assert.equal((await request("POST", "/photos/request-upload", {
    entityType: "safe_risk_assessment", entityId: 2147483647, name: "a.png", contentType: "image/png",
  })).status, 404, "resource ownership still precedes signing");
  assert.equal((await publicRequest("POST", "/fix-track/action/not-a-valid-token/upload-url", {})).status, 400, "invalid public token still fails normally");

  console.log(`${routes.length} upload routes returned the exact safe storage outage contract`);
} finally {
  if (db && clientId) await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`).catch(() => {});
  await pool?.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}