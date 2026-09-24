// Route integration coverage. Started by run-contractor-portal.sh, which boots
// the real API with NODE_ENV=test; direct SQL is used only to create impossible
// clock/integrity states and to clean up the isolated test tenants.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import crypto from "node:crypto";

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
const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");
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
    dbsType: "DBS Check (Basic)", dbsIssueDate: "2026-01-01", dbsExpiryDate: "2028-01-01",
  });
  const second = await owner.request("POST", "/contractors", {
    name: "Other Owner Contractor", email: `other-contractor-${Date.now()}@test.local`,
  });
  const foreignContractor = await foreign.request("POST", "/contractors", {
    name: "Foreign Contractor", email: `foreign-contractor-${Date.now()}@test.local`,
  });
  const contractorId = created.data?.id, secondId = second.data?.id, foreignId = foreignContractor.data?.id;
  check("contractors created", [contractorId, secondId, foreignId].every(Number.isInteger));
  check("manager records use canonical DBS types and dates",
    created.data?.dbsType === "Basic"
    && String(created.data?.dbsIssueDate).startsWith("2026-01-01")
    && String(created.data?.dbsExpiryDate).startsWith("2028-01-01"));

  check("anonymous cannot issue", (await publicRequest("POST", `/contractors/${contractorId}/portal-link`, {})).status === 401);
  const viewerEmail = `portal-viewer-${Date.now()}@test.local`;
  check("manager creates viewer", (await owner.request("POST", "/users", {
    name: "Viewer", email: viewerEmail, password: "password-123", role: "client_viewer", active: true,
  })).status === 201);
  const viewer = session();
  check("viewer login", (await viewer("POST", "/auth/login", { email: viewerEmail, password: "password-123" })).status === 200);
  check("viewer cannot issue", (await viewer("POST", `/contractors/${contractorId}/portal-link`, {})).status === 403);
  check("foreign manager cannot issue", (await foreign.request("POST", `/contractors/${contractorId}/portal-link`, {})).status === 404);

  // Allow reminder coverage to run independently of public portal fixtures.
  if (process.env.CONTRACTOR_RESEND_ONLY !== "1") {
  const issue1 = await owner.request("POST", `/contractors/${contractorId}/portal-link`, { expiresInDays: 2 });
  const token1 = issue1.data?.token;
  check("manager issue returns plaintext token once", issue1.status === 201 && typeof token1 === "string" && token1.length === 64);
  const view1 = await publicRequest("GET", `/contractor-portal/${token1}`);
  check("token sees only bound contractor", view1.status === 200 && view1.data?.name === created.data.name && !("notes" in view1.data));
  check("contractor portal reads the canonical DBS value", view1.data?.dbsType === "Basic");
  const [portalEvidence] = (await db.execute(sql`
    SELECT id FROM public_link_access_evidence
    WHERE client_id = ${owner.clientId} AND link_type = 'contractor_portal'
      AND token_fingerprint = ${digest(token1)}
    LIMIT 1
  `)).rows;
  check("valid contractor portal access leaves access evidence", portalEvidence?.id != null);

  const issue2 = await owner.request("POST", `/contractors/${contractorId}/portal-link`, {});
  const token2 = issue2.data?.token;
  check("reissue gives different token", issue2.status === 201 && token2 !== token1);
  const [storedToken] = (await db.execute(sql`SELECT token, token_hash FROM contractor_portal_tokens WHERE contractor_id = ${contractorId}`)).rows;
  check("portal raw token is not stored", storedToken?.token == null && storedToken?.token_hash === digest(token2));
  check("reissue invalidates old token", (await publicRequest("GET", `/contractor-portal/${token1}`)).status === 404);

  await db.execute(sql`UPDATE contractor_portal_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = ${digest(token2)}`);
  check("expired token rejected", (await publicRequest("GET", `/contractor-portal/${token2}`)).status === 404);
  const issue3 = await owner.request("POST", `/contractors/${contractorId}/portal-link`, {});
  const token3 = issue3.data.token;

  await db.execute(sql`UPDATE contractor_portal_tokens SET client_id = ${foreign.clientId} WHERE token_hash = ${digest(token3)}`);
  check("token/client inconsistency rejected", (await publicRequest("GET", `/contractor-portal/${token3}`)).status === 404);
  await db.execute(sql`UPDATE contractor_portal_tokens SET client_id = ${owner.clientId} WHERE token_hash = ${digest(token3)}`);

  const portalDbsChange = await publicRequest("PUT", `/contractor-portal/${token3}`, {
    dbsType: "PVG Scheme", dbsExpiryDate: "2028-03-01",
  });
  const portalDbsView = await publicRequest("GET", `/contractor-portal/${token3}`);
  check("contractor can update PVG expiry with a canonical type",
    portalDbsChange.status === 200 && portalDbsView.data?.dbsType === "PVG Scheme"
      && String(portalDbsView.data?.dbsExpiryDate).startsWith("2028-03-01"));
  const portalNone = await publicRequest("PUT", `/contractor-portal/${token3}`, {
    dbsType: "None", dbsExpiryDate: "2028-03-01",
  });
  const clearedDbs = await publicRequest("GET", `/contractor-portal/${token3}`);
  check("choosing None clears a previously saved DBS expiry",
    portalNone.status === 200 && clearedDbs.data?.dbsType === "None"
      && clearedDbs.data?.dbsExpiryDate === null);

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
  check("certificate object paths are never exposed by the portal", visible.every(c => !("object_path" in c)));
  check("other contractor certificate excluded", !visible.some(c => c.id === foreignCert.data.id));
  const certUrl = `/contractors/${contractorId}/certificates`;
  check("manager certificate list includes the created certificate",
    (await owner.request("GET", certUrl)).data?.some(c => c.id === managerCert.data.id));
  const changedCert = await owner.request("PUT", `${certUrl}/${managerCert.data.id}`, {
    certificateName: "Updated licence", issuer: "New issuer",
    completedDate: "2026-01-01", expiryDate: "2027-01-01", notes: "Updated by manager",
  });
  check("manager can edit certificate dates and notes", changedCert.status === 200
    && changedCert.data?.certificate_name === "Updated licence"
    && changedCert.data?.notes === "Updated by manager");
  check("certificate completion cannot be later than expiry",
    (await owner.request("PUT", `${certUrl}/${managerCert.data.id}`, {
      certificateName: "Invalid", completedDate: "2027-01-01", expiryDate: "2026-01-01",
    })).status === 400);
  check("another client cannot list certificates",
    (await foreign.request("GET", certUrl)).status === 404);
  check("another client cannot edit certificates",
    (await foreign.request("PUT", `${certUrl}/${managerCert.data.id}`, {
      certificateName: "Foreign edit",
    })).status === 404);
  check("another client cannot delete certificates",
    (await foreign.request("DELETE", `${certUrl}/${managerCert.data.id}`)).status === 404);
  check("manager can delete a certificate",
    (await owner.request("DELETE", `${certUrl}/${managerCert.data.id}`)).status === 204);
  check("deleting an absent certificate returns 404",
    (await owner.request("DELETE", `${certUrl}/${managerCert.data.id}`)).status === 404);
  const portalCreate = await publicRequest("POST", `/contractor-portal/${token3}/certificates`, {
    certificateName: "Portal certificate", notes: "must-not-be-accepted",
  });
  const [stored] = (await db.execute(sql`SELECT notes FROM contractor_certificates WHERE id = ${portalCreate.data?.id}`)).rows;
  check("portal notes ignored rather than accepted", portalCreate.status === 201 && stored?.notes == null);
  check("token cannot delete other contractor certificate",
    (await publicRequest("DELETE", `/contractor-portal/${token3}/certificates/${foreignCert.data.id}`)).status === 404);
  const missingUpload = await publicRequest("POST", `/contractor-portal/${token3}/certificates`, {
    certificateName: "Missing upload", objectPath: `/objects/uploads/tenant-${owner.clientId}/does-not-exist`,
  });
  check("missing or inaccessible object rejected", [403, 404].includes(missingUpload.status), String(missingUpload.status));
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

  }
  // Resends preserve the latest dispatched snapshot and never send directly.
  const item = (await db.execute(sql`INSERT INTO compliance_items (client_id, contractor_id, title)
    VALUES (${owner.clientId}, ${contractorId}, 'Resend fixture') RETURNING id`)).rows[0];
  const resendPath = `/contractors/${contractorId}/reminders/${item.id}/resend`;
  check("resend requires prior delivery", (await owner.request("POST", resendPath)).status === 404);
  check("viewer cannot resend", (await viewer("POST", resendPath)).status === 403);
  check("foreign tenant cannot resend", (await foreign.request("POST", resendPath)).status === 404);
  check("anonymous cannot resend", (await publicRequest("POST", resendPath)).status === 401);
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:resend-fixture\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  await db.execute(sql`INSERT INTO contractor_email_queue
    (client_id, contractor_id, entity_type, entity_id, mode, email_type, status, to_email,
     subject, body_html, body_text, ics_content, ics_filename, idempotency_key, sent_at)
    VALUES (${owner.clientId}, ${contractorId}, 'compliance', ${item.id}, 'assign', 'reminder', 'sent',
     ${created.data.email}, 'Latest reminder', '<p>Latest reminder</p>', 'Latest reminder',
     ${ics}, 'visit.ics', ${crypto.randomUUID()}, now())`);
  const attempts = await Promise.all([owner.request("POST", resendPath), owner.request("POST", resendPath)]);
  check("concurrent resends create only one approval", attempts.map(r => r.status).sort().join(",") === "202,409");
  const draft = (await db.execute(sql`SELECT * FROM contractor_email_queue
    WHERE client_id=${owner.clientId} AND entity_id=${item.id} AND status='pending'`)).rows[0];
  check("resend preserves content and calendar", draft?.subject === "Latest reminder"
    && draft?.ics_content === ics && draft?.ics_filename === "visit.ics" && draft?.sent_at == null);
  check("resend records requesting manager", Number.isInteger(draft?.requested_by));
  check("wrong contractor cannot resend item",
    (await owner.request("POST", `/contractors/${secondId}/reminders/${item.id}/resend`)).status === 404);
  await db.execute(sql`UPDATE compliance_items SET status='completed' WHERE id=${item.id}`);
  check("completed requirement cannot resend", (await owner.request("POST", resendPath)).status === 404);

  console.log(`${passed} contractor portal route checks passed, ${failures} failed`);
} finally {
  try {
    if (db && clientIds.length) await db.execute(sql`DELETE FROM clients WHERE id IN (${clientIds[0]}, ${clientIds[1]})`);
  } catch (error) { console.error("Cleanup failed:", error); failures++; }
  await pool?.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}
if (failures) process.exit(1);