// An open SafeTrack or DocTrack acknowledgements dialog polls with
// ?sinceId=<latest ack id> to pick up staff self-signatures without
// re-downloading every row. Covers the incremental lists, the overlap window,
// the fallbacks, and that the public sign-off link works without a session.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const execFile = promisify(execFileCallback);
let failures = 0;

function check(name, condition) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

function requireSuccess(name, response, expectedStatus) {
  check(name, response.status === expectedStatus);
  if (response.status !== expectedStatus) {
    console.error(`${name}: status ${response.status}`, response.data);
    throw new Error(`${name} setup failed`);
  }
}

function session() {
  let jar = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(jar ? { cookie: jar } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) jar = setCookie.split(";")[0];
    const contentType = response.headers.get("content-type") ?? "";
    return { status: response.status, data: contentType.includes("application/json") ? await response.json() : null };
  };
}

async function signUp(label) {
  const as = session();
  const email = `safe-refresh-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const registered = await as("POST", "/auth/register", { name: `Safe refresh ${label}`, email, password: "password-123" });
  requireSuccess(`register ${label}`, registered, 200);
  requireSuccess(`verify ${label}`,
    await as("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), 200);
  requireSuccess(`log in ${label}`, await as("POST", "/auth/login", { email, password: "password-123" }), 200);
  const me = await as("GET", "/auth/me");
  const user = me.data?.user ?? me.data;
  if (!Number.isInteger(user?.clientId)) throw new Error(`${label} has no client`);
  return { as, clientId: user.clientId };
}

const psql = (query) => execFile("psql", [process.env.DATABASE_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c", query]);

const manager = await signUp("manager");
const other = await signUp("other");
const { as } = manager;

const staff = [];
for (const name of ["Refresh Staff One", "Refresh Staff Two"]) {
  const created = await as("POST", "/staff-roster", { name, email: `safe-refresh-${staff.length}-${Date.now()}@test.local` });
  requireSuccess(`create ${name}`, created, 201);
  staff.push({ id: Number(created.data?.id), name });
}
const ra = await as("POST", "/safe-track/risk-assessments", {
  title: "Refresh fixture assessment", status: "published", requiresAcknowledgement: true,
});
requireSuccess("create risk assessment", ra, 201);
const listPath = `/safe-track/risk-assessments/${ra.data.id}/acknowledgements`;

// The manager records the first acknowledgement in the dialog.
requireSuccess("manager records an acknowledgement", await as("POST", `/safe-track/risk-assessments/${ra.data.id}/acknowledge`, {
  acknowledgements: [{ staffRosterId: staff[0].id, staffName: staff[0].name, signature: "Typed One" }],
}), 200);
const initial = await as("GET", listPath);
check("full list holds the manager's row", initial.status === 200 && initial.data?.length === 1);
const firstAckId = Number(initial.data?.[0]?.id);

// A second staff member signs on their own device through the public link.
const link = await as("POST", "/doc-track/sign-off-info");
requireSuccess("issue sign-off link", link, 201);
const publicAs = session();
requireSuccess("staff self-signs the risk assessment", await publicAs("POST", `/sign-off/${link.data.token}/acknowledge`, {
  documentType: "ra", documentId: ra.data.id, staffRosterId: staff[1].id,
  signature: "data:image/png;base64,iVBORw0KGgo=",
}), 201);

const polled = await as("GET", `${listPath}?sinceId=${firstAckId}`);
const polledStaff = new Set((polled.data ?? []).map((row) => row.staff_roster_id));
check("poll returns the new self-signature", polled.status === 200 && polledStaff.has(staff[1].id));
const secondAckId = Number((polled.data ?? []).find((row) => row.staff_roster_id === staff[1].id)?.id);

// Rows older than the overlap window are left out of later polls.
await psql(`UPDATE safe_track_acknowledgements SET acknowledged_at = acknowledged_at - interval '1 hour' WHERE id = ${firstAckId}`);
const narrowed = await as("GET", `${listPath}?sinceId=${secondAckId}`);
check("poll skips rows older than the overlap window",
  narrowed.status === 200 && narrowed.data?.length === 1 && narrowed.data[0].id === secondAckId);

// Rows just before the latest one are still returned, for late commits.
await psql(`UPDATE safe_track_acknowledgements SET acknowledged_at = (SELECT acknowledged_at FROM safe_track_acknowledgements WHERE id = ${secondAckId}) - interval '1 minute' WHERE id = ${firstAckId}`);
const overlapped = await as("GET", `${listPath}?sinceId=${secondAckId}`);
check("poll repeats rows inside the overlap window", overlapped.status === 200 && overlapped.data?.length === 2);

// Another client's ack id falls back to this document's full list, never theirs.
await psql(`INSERT INTO safe_track_acknowledgements (client_id, document_type, document_id, staff_roster_id, staff_name)
  VALUES (${Number(other.clientId)}, 'ra', ${Number(ra.data.id)}, NULL, 'Foreign row')`);
const foreignId = Number((await psql(`SELECT max(id) FROM safe_track_acknowledgements WHERE client_id = ${Number(other.clientId)}`)).stdout.trim());
const foreign = await as("GET", `${listPath}?sinceId=${foreignId}`);
check("foreign ack id falls back to the full list without foreign rows",
  foreign.status === 200 && foreign.data?.length === 2 && foreign.data.every((row) => row.staff_name !== "Foreign row"));

const garbage = await as("GET", `${listPath}?sinceId=not-a-number`);
check("invalid sinceId returns the full list", garbage.status === 200 && garbage.data?.length === 2);

// DocTrack, where /safe-track now redirects, supports the same incremental poll.
const docInsert = await psql(`INSERT INTO doc_track_documents
    (client_id,title,category,file_name,mime_type,object_path,requires_acknowledgement,annual_acknowledgement)
  VALUES (${Number(manager.clientId)},'Refresh fixture policy','risk_assessment','refresh.pdf','application/pdf','fixtures/refresh.pdf',true,false)
  RETURNING id`);
const docId = Number(docInsert.stdout.trim().split("\n")[0]);
const docListPath = `/doc-track/documents/${docId}/acknowledgements`;
const managerDocAck = await as("POST", `/doc-track/documents/${docId}/acknowledge`, {
  acknowledgements: [{ staffRosterId: staff[0].id, staffName: staff[0].name, signature: "Typed One" }],
});
check("manager records a DocTrack acknowledgement", [200, 201].includes(managerDocAck.status));
requireSuccess("staff self-signs the DocTrack document", await publicAs("POST", `/sign-off/${link.data.token}/acknowledge`, {
  documentType: "doc", documentId: docId, staffRosterId: staff[1].id, typedName: staff[1].name,
}), 201);
const docFull = await as("GET", docListPath);
check("DocTrack full list holds both rows", docFull.status === 200 && docFull.data?.length === 2);
const docRow = (staffId) => (docFull.data ?? []).find((row) => row.staff_roster_id === staffId);
await psql(`UPDATE doc_acknowledgements SET acknowledged_at = acknowledged_at - interval '1 hour' WHERE id = ${Number(docRow(staff[0].id)?.id)}`);
const docPolled = await as("GET", `${docListPath}?sinceId=${Number(docRow(staff[1].id)?.id)}`);
check("DocTrack poll returns only the recent self-signature",
  docPolled.status === 200 && docPolled.data?.length === 1 && docPolled.data[0].staff_roster_id === staff[1].id);
const docGarbage = await as("GET", `${docListPath}?sinceId=0`);
check("DocTrack without a usable sinceId returns the full list", docGarbage.status === 200 && docGarbage.data?.length === 2);

await psql(`DELETE FROM safe_track_acknowledgements WHERE client_id IN (${Number(manager.clientId)}, ${Number(other.clientId)})`);
await psql(`DELETE FROM doc_acknowledgements WHERE client_id = ${Number(manager.clientId)}`);

if (failures) {
  console.error(`${failures} SafeTrack acknowledgement refresh check(s) failed`);
  process.exit(1);
}
console.log("SafeTrack acknowledgement refresh checks passed");
