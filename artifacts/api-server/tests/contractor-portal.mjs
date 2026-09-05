// Route integration coverage. Started by run-contractor-portal.sh, which boots
// the real API with NODE_ENV=test; direct SQL is used only to create impossible
// clock/integrity states and to clean up the isolated test tenants.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required; use tests/run-contractor-portal.sh");
const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-contractor-portal-"));
let failures = 0, passed = 0;
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures++; console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
}
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
async function tenant(label) {
  const request = session();
  const email = `portal-${label}-${Date.now()}-${Math.random()}@test.local`;
  const reg = await request("POST", "/auth/register", { name: `${label} manager`, email, password: "password-123" });
  check(`${label} registration`, [200, 201].includes(reg.status), String(reg.status));
  if (!reg.data?.verificationToken) throw new Error("test registration did not return verificationToken");
  check(`${label} verification`, (await request("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`)).status === 200);
  check(`${label} login`, (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  const me = await request("GET", "/auth/me");
  return { request, clientId: (me.data?.user ?? me.data)?.clientId };
}
async function publicRequest(method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

let db, pool, sql, clientIds = [];
try {
  const outfile = path.join(outDir, "db.mjs");
  await build({
    entryPoints: [path.join(dir, "contractor-portal.entry.ts")], bundle: true,
    platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);" },
  });
  ({ db, pool, sql } = await import(outfile));
  const owner = await tenant("owner");
  const foreign = await tenant("foreign");
  clientIds = [owner.clientId, foreign.clientId];

  const created = await owner.request("POST", "/contractors", {
    name: "Portal Owner Contractor", email: `owner-contractor-${Date.now()}@test.local`,
  });
  const second = await owner.request("POST", "/contractors", {
    name: "Other Owner Contractor", email: `other-contractor-${Date.now()}@test.local`,
  });
  const foreignContractor = await foreign.request("POST", "/contractors", {
    name: "Foreign Contractor", email: `foreign-contractor-${Date.now()}@test.local`,
  });
  const contractorId = created.data?.id, secondId = second.data?.id, foreignId = foreignContractor.data?.id;
  check("contractors created", [contractorId, secondId, foreignId].every(Number.isInteger));

  check("anonymous cannot issue", (await publicRequest("POST", `/contractors/${contractorId}/portal-link`, {})).status === 401);
  const viewerEmail = `portal-viewer-${Date.now()}@test.local`;
  check("manager creates viewer", (await owner.request("POST", "/users", {
    name: "Viewer", email: viewerEmail, password: "password-123", role: "client_viewer", active: true,
  })).status === 201);
  const viewer = session();
  check("viewer login", (await viewer("POST", "/auth/login", { email: viewerEmail, password: "password-123" })).status === 200);
  check("viewer cannot issue", (await viewer("POST", `/contractors/${contractorId}/portal-link`, {})).status === 403);
  check("foreign manager cannot issue", (await foreign.request("POST", `/contractors/${contractorId}/portal-link`, {})).status === 404);

  const issue1 = await owner.request("POST", `/contractors/${contractorId}/portal-link`, { expiresInDays: 2 });
  const token1 = issue1.data?.token;
  check("manager issue returns plaintext token once", issue1.status === 201 && typeof token1 === "string" && token1.length === 64);
  const view1 = await publicRequest("GET", `/contractor-portal/${token1}`);
  check("token sees only bound contractor", view1.status === 200 && view1.data?.name === created.data.name && !("notes" in view1.data));

  const issue2 = await owner.request("POST", `/contractors/${contractorId}/portal-link`, {});
  const token2 = issue2.data?.token;
  check("reissue gives different token", issue2.status === 201 && token2 !== token1);
  check("reissue invalidates old token", (await publicRequest("GET", `/contractor-portal/${token1}`)).status === 404);

  await db.execute(sql`UPDATE contractor_portal_tokens SET expires_at = now() - interval '1 minute' WHERE token = ${token2}`);
  check("expired token rejected", (await publicRequest("GET", `/contractor-portal/${token2}`)).status === 404);
  const issue3 = await owner.request("POST", `/contractors/${contractorId}/portal-link`, {});
  const token3 = issue3.data.token;

  await db.execute(sql`UPDATE contractor_portal_tokens SET client_id = ${foreign.clientId} WHERE token = ${token3}`);
  check("token/client inconsistency rejected", (await publicRequest("GET", `/contractor-portal/${token3}`)).status === 404);
  await db.execute(sql`UPDATE contractor_portal_tokens SET client_id = ${owner.clientId} WHERE token = ${token3}`);

  const managerCert = await owner.request("POST", `/contractors/${contractorId}/certificates`, {
    certificateName: "Manager certificate", issuer: "Issuer", notes: "manager-only-note",
  });
  const foreignCert = await owner.request("POST", `/contractors/${secondId}/certificates`, {
    certificateName: "Other certificate", notes: "other-manager-note",
  });
  check("manager certificates created", managerCert.status === 201 && foreignCert.status === 201);
  const portalAfterCert = await publicRequest("GET", `/contractor-portal/${token3}`);
  const visible = portalAfterCert.data?.certificates ?? [];
  check("manager notes never disclosed", visible.some(c => c.id === managerCert.data.id) && visible.every(c => !("notes" in c)));
  check("other contractor certificate excluded", !visible.some(c => c.id === foreignCert.data.id));
  const portalCreate = await publicRequest("POST", `/contractor-portal/${token3}/certificates`, {
    certificateName: "Portal certificate", notes: "must-not-be-accepted",
  });
  const [stored] = (await db.execute(sql`SELECT notes FROM contractor_certificates WHERE id = ${portalCreate.data?.id}`)).rows;
  check("portal notes ignored rather than accepted", portalCreate.status === 201 && stored?.notes == null);
  check("token cannot delete other contractor certificate",
    (await publicRequest("DELETE", `/contractor-portal/${token3}/certificates/${foreignCert.data.id}`)).status === 404);
  check("missing object rejected",
    (await publicRequest("POST", `/contractor-portal/${token3}/certificates`, {
      certificateName: "Missing upload", objectPath: `/objects/uploads/tenant-${owner.clientId}/does-not-exist`,
    })).status === 404);
  check("foreign object path rejected",
    (await publicRequest("POST", `/contractor-portal/${token3}/certificates`, {
      certificateName: "Foreign upload", objectPath: `/objects/uploads/tenant-${foreign.clientId}/foreign`,
    })).status === 403);
  if (process.env.CONTRACTOR_PORTAL_TEST_OBJECT_PATH) {
    const stagedPath = process.env.CONTRACTOR_PORTAL_TEST_OBJECT_PATH.replace("{tenantId}", String(owner.clientId));
    const finalized = await publicRequest("POST", `/contractor-portal/${token3}/certificates`, {
      certificateName: "Valid uploaded certificate", objectPath: stagedPath,
    });
    const [finalizedRow] = finalized.status === 201
      ? (await db.execute(sql`SELECT object_path FROM contractor_certificates WHERE id = ${finalized.data.id}`)).rows
      : [];
    check("valid storage fixture is copied to finalized tenant key",
      finalized.status === 201
        && finalizedRow?.object_path?.startsWith(`/objects/finalized/tenant-${owner.clientId}/`)
        && finalizedRow.object_path !== stagedPath,
      `${finalized.status}: ${JSON.stringify(finalized.data)}`);
  } else {
    console.log("SKIP: valid finalized object (set CONTRACTOR_PORTAL_TEST_OBJECT_PATH to a real reserved PDF fixture)");
  }

  check("manager revokes", (await owner.request("DELETE", `/contractors/${contractorId}/portal-link`)).status === 204);
  check("revoked token rejected", (await publicRequest("GET", `/contractor-portal/${token3}`)).status === 404);
  // No raw token appears in the contractor record or audit details.
  const contractorView = await owner.request("GET", `/contractors/${contractorId}`);
  const auditRows = (await db.execute(sql`
    SELECT details FROM contractor_portal_audit_log
    WHERE client_id = ${owner.clientId} AND contractor_id = ${contractorId}
  `)).rows;
  check("plaintext token only in issuance response",
    !JSON.stringify(contractorView.data).includes(token3) && !JSON.stringify(auditRows).includes(token3));

  console.log(`${passed} contractor portal route checks passed, ${failures} failed`);
} finally {
  try {
    if (db && clientIds.length) await db.execute(sql`DELETE FROM clients WHERE id IN (${clientIds[0]}, ${clientIds[1]})`);
  } catch (error) { console.error("Cleanup failed:", error); failures++; }
  await pool?.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}
if (failures) process.exit(1);