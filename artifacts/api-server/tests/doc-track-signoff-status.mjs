// End-to-end coverage for DocTrack's current acknowledgement status and the
// Pest Control PAT preset's tenant-scoped template API.
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { skipWhenStorageUnavailable } from "./storage-test-availability.mjs";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const execFile = promisify(execFileCallback);
let cookie = "";
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

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    contentType,
    disposition: response.headers.get("content-disposition"),
    data: contentType.includes("application/json")
      ? await response.json()
      : null,
    bytes: contentType.includes("application/json")
      ? null
      : Buffer.from(await response.arrayBuffer()),
  };
}

function isoDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const email = `doc-status-${Date.now()}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: "Doc Status Test", email, password: "password-123",
  });
  requireSuccess("register account", registered, 200);
  check("test server exposes verification token", typeof registered.data?.verificationToken === "string");
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  requireSuccess(
    "verify account",
    await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`),
    200,
  );
  requireSuccess("log in", await request("POST", "/auth/login", { email, password: "password-123" }), 200);
  const managerCookie = cookie;
  const me = await request("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.client?.id;
  check("manager has client context", clientId != null);

  const allowedOrigin = "http://localhost:5173";
  const allowedPreflight = await fetch(`${BASE}/sites`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  check("CORS permits the exact configured origin",
    allowedPreflight.headers.get("access-control-allow-origin") === allowedOrigin);
  const foreignOrigin = "http://localhost:5173.attacker.invalid";
  const blockedPreflight = await fetch(`${BASE}/sites`, {
    method: "OPTIONS",
    headers: {
      Origin: foreignOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  check("CORS does not accept an origin that only shares a hostname prefix",
    blockedPreflight.headers.get("access-control-allow-origin") !== foreignOrigin);

  const issueSignOff = () => request("POST", "/doc-track/sign-off-info");
  const signOffCreated = await issueSignOff();
  requireSuccess("manager creates an expiring sign-off link", signOffCreated, 201);
  const firstSignOffToken = signOffCreated.data?.token;
  check("sign-off token has high entropy", /^[a-f0-9]{64}$/.test(firstSignOffToken ?? ""));
  check("sign-off link expires in the future", new Date(signOffCreated.data?.expiresAt).getTime() > Date.now());
  const publicInfo = await request("GET", `/sign-off/${firstSignOffToken}/info`);
  requireSuccess("active sign-off token resolves with the manager's session cookie", publicInfo, 200);

  const fingerprint = createHash("sha256").update(firstSignOffToken).digest("hex");
  const evidence = await execFile("psql", [
    process.env.DATABASE_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c",
    `SELECT count(*) FROM public_link_access_evidence WHERE client_id=${Number(clientId)} AND link_type='sign_off' AND token_fingerprint='${fingerprint}'`,
  ]);
  check("valid public sign-off access leaves a hashed access-evidence row",
    Number(evidence.stdout.trim()) >= 1, evidence.stdout.trim());

  await execFile("psql", [
    process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
    `UPDATE clients SET sign_off_token_expires_at=now()-interval '1 minute' WHERE id=${Number(clientId)} AND sign_off_token='${firstSignOffToken}'`,
  ]);
  check("expired sign-off token is rejected",
    (await request("GET", `/sign-off/${firstSignOffToken}/info`)).status === 404);

  const renewedSignOff = await issueSignOff();
  requireSuccess("manager can renew an expired sign-off link", renewedSignOff, 201);
  check("renewal rotates the bearer token", renewedSignOff.data?.token !== firstSignOffToken);
  check("replaced token is invalid immediately",
    (await request("GET", `/sign-off/${firstSignOffToken}/info`)).status === 404);
  requireSuccess("renewed token resolves", await request("GET", `/sign-off/${renewedSignOff.data?.token}/info`), 200);

  const rateLimitLink = await issueSignOff();
  requireSuccess("manager can rotate a sign-off link again", rateLimitLink, 201);
  let rateLimitRequestsPassed = true;
  for (let attempt = 0; attempt < 60; attempt++) {
    const attemptResponse = await request("GET", `/sign-off/${rateLimitLink.data?.token}/info`);
    if (attemptResponse.status !== 200) rateLimitRequestsPassed = false;
  }
  check("public sign-off link permits requests up to its per-token limit", rateLimitRequestsPassed);
  check("public sign-off link is rate-limited after 60 requests",
    (await request("GET", `/sign-off/${rateLimitLink.data?.token}/info`)).status === 429);

  const finalSignOff = await issueSignOff();
  requireSuccess("manager can renew after a rate-limited token", finalSignOff, 201);
  const rotatedTokenLookup = await execFile("psql", [
    process.env.DATABASE_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c",
    `SELECT count(*) FROM clients WHERE id=${Number(clientId)} AND sign_off_token='${rateLimitLink.data?.token}'`,
  ]);
  check("rotation replaces the prior bearer token",
    Number(rotatedTokenLookup.stdout.trim()) === 0);
  requireSuccess("manager revokes the renewed link", await request("DELETE", "/doc-track/sign-off-info"), 204);
  check("revoked sign-off token is rejected",
    (await request("GET", `/sign-off/${finalSignOff.data?.token}/info`)).status === 404);

  const kitchenDepartment = await request("POST", "/departments", { name: "Kitchen" });
  requireSuccess("create Kitchen department", kitchenDepartment, 201);
  const primarySite = await request("POST", "/sites", {
    name: "DocTrack primary site", departmentId: kitchenDepartment.data?.id,
  });
  requireSuccess("create primary site", primarySite, 201);
  const otherSite = await request("POST", "/sites", {
    name: "DocTrack other site", departmentId: kitchenDepartment.data?.id,
  });
  requireSuccess("create other site", otherSite, 201);
  const otherDepartment = await request("POST", "/departments", { name: "DocTrack other department" });
  requireSuccess("create other department", otherDepartment, 201);
  const otherDepartmentSite = await request("POST", "/sites", {
    name: "DocTrack other department site", departmentId: otherDepartment.data?.id,
  });
  requireSuccess("create other department site", otherDepartmentSite, 201);
  const staff = await request("POST", "/staff-roster", {
    name: "Alex Staff", email: `doc-active-${Date.now()}@test.local`,
    siteId: primarySite.data?.id, department: "Kitchen",
  });
  requireSuccess("create roster staff", staff, 201);
  const inactiveStaff = await request("POST", "/staff-roster", {
    name: "Former Staff", email: `doc-inactive-${Date.now()}@test.local`,
    siteId: primarySite.data?.id, department: "Kitchen", active: false,
  });
  requireSuccess("create inactive roster staff", inactiveStaff, 201);
  const otherSiteStaff = await request("POST", "/staff-roster", {
    name: "Other Site Staff", email: `doc-other-site-${Date.now()}@test.local`,
    siteId: otherSite.data?.id, department: "Kitchen",
  });
  requireSuccess("create other-site roster staff", otherSiteStaff, 201);
  const otherDepartmentStaff = await request("POST", "/staff-roster", {
    name: "Other Department Staff", email: `doc-other-dept-${Date.now()}@test.local`,
    siteId: primarySite.data?.id, department: "Housekeeping",
  });
  requireSuccess("create other-department roster staff", otherDepartmentStaff, 201);

  // This fixture does not depend on object storage, so personal-signoff
  // regressions still run in environments where upload signing is unavailable.
  const staffEmail = staff.data?.email;
  requireSuccess("create linked staff account", await request("POST", "/users", {
    name: "A different account display name", email: staffEmail,
    password: "password-123", role: "client_staff", clientId,
    departmentId: kitchenDepartment.data?.id,
  }), 201);
  const fixtureResult = await execFile("psql", [
    process.env.DATABASE_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c",
    `INSERT INTO doc_track_documents
      (client_id,site_id,title,category,file_name,mime_type,object_path,requires_acknowledgement,annual_acknowledgement,department)
     VALUES (${Number(clientId)},${Number(primarySite.data?.id)},'Staff signoff fixture','policy','fixture.pdf','application/pdf','fixtures/staff-signoff.pdf',true,true,'Kitchen')
     RETURNING id`,
  ]);
  const fixtureId = Number(fixtureResult.stdout.trim().split("\n")[0]);
  check("fixture document inserted", Number.isInteger(fixtureId) && fixtureId > 0);
  cookie = "";
  requireSuccess("log in linked staff", await request("POST", "/auth/login", {
    email: staffEmail, password: "password-123",
  }), 200);
  let personal = await request("GET", "/doc-track/acknowledgements/my");
  check("personal list shows only eligible pending documents, despite a different display name",
    personal.status === 200 && personal.data?.rosterLinked === true
      && personal.data?.pending?.some((d) => d.id === fixtureId));
  const signed = await request("POST", `/doc-track/documents/${fixtureId}/acknowledge`, {
    self: true, signature: "Typed signature", staffRosterId: otherSiteStaff.data?.id,
    staffName: "Forged name",
  });
  check("self sign-off cannot impersonate another roster entry",
    signed.status === 201 && signed.data?.created === 1
      && signed.data?.records?.[0]?.staff_roster_id === staff.data?.id);
  check("repeat self sign-off is idempotent",
    (await request("POST", `/doc-track/documents/${fixtureId}/acknowledge`, { self: true })).data?.created === 0);
  personal = await request("GET", "/doc-track/acknowledgements/my");
  check("completed list contains the acknowledgement date",
    personal.data?.pending?.every((d) => d.id !== fixtureId)
      && !!personal.data?.completed?.find((d) => d.id === fixtureId)?.acknowledged_at);
  cookie = managerCookie;
  const managerList = await request("GET", "/doc-track/documents");
  check("manager acknowledgement totals use the self sign-off evidence",
    Number(managerList.data?.find((d) => d.id === fixtureId)?.acknowledged_count) === 1);
  await execFile("psql", [
    process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
    `UPDATE train_track_records SET expiry_date=CURRENT_DATE-1
     WHERE id=${Number(signed.data?.records?.[0]?.train_track_record_id)}`,
  ]);
  cookie = "";
  requireSuccess("log in linked staff after expiry", await request("POST", "/auth/login", {
    email: staffEmail, password: "password-123",
  }), 200);
  personal = await request("GET", "/doc-track/acknowledgements/my");
  check("expired annual sign-off returns to the pending list",
    personal.data?.pending?.some((d) => d.id === fixtureId));
  const renewedFixture = await request("POST", `/doc-track/documents/${fixtureId}/acknowledge`, { self: true });
  check("staff can renew an expired annual acknowledgement",
    renewedFixture.status === 201 && renewedFixture.data?.created === 1);
  cookie = managerCookie;
  check("manager without a matching roster sees an unlinked personal view",
    (await request("GET", "/doc-track/acknowledgements/my")).data?.rosterLinked === false);
  await execFile("psql", [
    process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
    `DELETE FROM doc_track_documents WHERE id=${fixtureId} AND client_id=${Number(clientId)};
     DELETE FROM train_track_records WHERE id IN
       (${Number(signed.data?.records?.[0]?.train_track_record_id)},
        ${Number(renewedFixture.data?.records?.[0]?.train_track_record_id)}) AND client_id=${Number(clientId)}`,
  ]);

  const uploadRequest = await request("POST", "/doc-track/documents/request-upload", {
    name: "annual-safety-policy.pdf",
    contentType: "application/pdf",
  });
  if (skipWhenStorageUnavailable(uploadRequest, "DocTrack sign-off integration")) return;
  requireSuccess("request document upload", uploadRequest, 200);
  check("document upload URL is returned", typeof uploadRequest.data?.uploadUrl === "string");
  check("document object path is returned", typeof uploadRequest.data?.objectPath === "string");
  if (typeof uploadRequest.data?.uploadUrl !== "string" || typeof uploadRequest.data?.objectPath !== "string") {
    throw new Error("request document upload returned an invalid payload");
  }
  const uploaded = await fetch(uploadRequest.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: Buffer.from("%PDF-1.4\nDocTrack ACL test\n"),
  });
  check("upload document bytes", uploaded.ok);
  if (!uploaded.ok) throw new Error(`document upload failed with status ${uploaded.status}`);

  const document = await request("POST", "/doc-track/documents", {
    title: "Annual safety policy",
    category: "policy",
    fileName: "annual-safety-policy.pdf",
    mimeType: "application/pdf",
    objectPath: uploadRequest.data.objectPath,
    siteId: primarySite.data?.id,
    department: "Kitchen",
    requiresAcknowledgement: true,
    annualAcknowledgement: true,
  });
  requireSuccess("create acknowledgement document", document, 201);
  requireSuccess(
    "download tenant-owned document",
    await request("GET", `/storage${uploadRequest.data.objectPath}`),
    200,
  );

  let listed = await request("GET", "/doc-track/documents");
  requireSuccess("list acknowledgement documents", listed, 200);
  check("document list response is an array", Array.isArray(listed.data));
  if (!Array.isArray(listed.data)) throw new Error("Document list response is not an array");
  let row = listed.data.find((item) => item.id === document.data?.id);
  check("new document status is pending", row?.acknowledgement_status === "pending");
  check("new document pending count is returned", Number(row?.pending_acknowledgement_count) === 1);
  for (const [label, roster] of [
    ["inactive", inactiveStaff],
    ["other-site", otherSiteStaff],
    ["other-department", otherDepartmentStaff],
  ]) {
    const rosterEmail = roster.data?.email;
    requireSuccess(`create ${label} staff user`, await request("POST", "/users", {
      name: roster.data?.name, email: rosterEmail, password: "password-123", role: "client_staff",
      clientId, departmentId: kitchenDepartment.data?.id,
    }), 201);
    cookie = "";
    requireSuccess(`log in ${label} staff`, await request("POST", "/auth/login", {
      email: rosterEmail, password: "password-123",
    }), 200);
    check(`${label} staff self acknowledgement is denied`,
      (await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, { signature: "forged" })).status === 403);
    const privateList = await request("GET", "/doc-track/acknowledgements/my");
    check(`${label} staff cannot see an ineligible document in their personal list`,
      privateList.status === 200 && !privateList.data?.pending?.some((item) => item.id === document.data?.id));
    cookie = managerCookie;
  }

  const acknowledged = await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, {
    acknowledgements: [
      { staffRosterId: staff.data?.id, staffName: "Forged name" },
      { staffRosterId: inactiveStaff.data?.id, staffName: "Former Staff" },
      { staffRosterId: otherSiteStaff.data?.id, staffName: "Other Site Staff" },
      { staffRosterId: otherDepartmentStaff.data?.id, staffName: "Other Department Staff" },
    ],
  });
  check("manager bulk acknowledgement only includes eligible active population", acknowledged.status === 201 && acknowledged.data?.created === 1);
  const trainRecordId = acknowledged.data?.records?.[0]?.train_track_record_id;
  check("acknowledgement links TrainTrack record", typeof trainRecordId === "number");
  const acknowledgementPopulation = await request("GET", `/doc-track/documents/${document.data?.id}/acknowledgements`);
  requireSuccess("load eligible acknowledgement population", acknowledgementPopulation, 200);
  check("manager bulk creates evidence only for the eligible staff member",
    acknowledgementPopulation.data?.length === 1 && acknowledgementPopulation.data[0]?.staff_roster_id === staff.data?.id);

  const manualTrainRecord = await request("POST", "/train-track/records", {
    recordType: "internal",
    staffName: "Alex Staff",
    trainingType: "Fire drill",
    trainer: "Safety Manager",
    completedDate: isoDate(),
    signature: "Alex Staff",
  });
  requireSuccess("create TrainTrack record", manualTrainRecord, 201);
  check("TrainTrack persists record signature", manualTrainRecord.data?.signature === "Alex Staff");
  const listedBeforeUnrelatedEdit = await request("GET", "/train-track/records");
  requireSuccess("list TrainTrack signature before unrelated edit", listedBeforeUnrelatedEdit, 200);
  check("TrainTrack list includes saved signature",
    listedBeforeUnrelatedEdit.data?.find((record) => record.id === manualTrainRecord.data?.id)?.signature === "Alex Staff");
  const updatedTrainRecord = await request("PATCH", `/train-track/records/${manualTrainRecord.data?.id}`, {
    notes: "Annual drill completed",
  });
  requireSuccess("update TrainTrack record", updatedTrainRecord, 200);
  check("TrainTrack update persists notes", updatedTrainRecord.data?.notes === "Annual drill completed");
  const reloadedTrainRecords = await request("GET", "/train-track/records");
  requireSuccess("reload TrainTrack records", reloadedTrainRecords, 200);
  const reloadedTrainRecord = reloadedTrainRecords.data?.find((record) => record.id === manualTrainRecord.data?.id);
  check("TrainTrack list retains signature after unrelated edit", reloadedTrainRecord?.signature === "Alex Staff");

  listed = await request("GET", "/doc-track/documents");
  row = listed.data?.find((item) => item.id === document.data?.id);
  check("current acknowledgement status is acknowledged", row?.acknowledgement_status === "acknowledged");
  check("current acknowledgement count is returned", Number(row?.acknowledged_count) === 1);

  const expire = await request("PATCH", `/train-track/records/${trainRecordId}`, { expiryDate: isoDate(-1) });
  check("expire linked TrainTrack sign-off", expire.status === 200);
  listed = await request("GET", "/doc-track/documents");
  row = listed.data?.find((item) => item.id === document.data?.id);
  check("DocTrack reconciles expired linked sign-off", row?.acknowledgement_status === "expired");
  check("expired acknowledgement count is returned", Number(row?.expired_acknowledgement_count) === 1);

  let overview = await request("GET", "/doc-track/acknowledgements/outstanding");
  requireSuccess("load outstanding acknowledgement overview", overview, 200);
  let overviewRow = overview.data?.documents?.find((item) => item.id === document.data?.id);
  check("expired annual sign-off appears outstanding", overviewRow?.outstanding?.some((item) => item.id === staff.data?.id));

  cookie = "";
  requireSuccess("log in linked staff", await request("POST", "/auth/login", {
    email: staffEmail, password: "password-123",
  }), 200);
  const pendingMine = await request("GET", "/doc-track/acknowledgements/my");
  check("personal list shows only the expired in-scope annual document",
    pendingMine.status === 200 && pendingMine.data?.rosterLinked === true
      && pendingMine.data?.pending?.some((item) => item.id === document.data?.id)
      && !pendingMine.data?.completed?.some((item) => item.id === document.data?.id));
  const renewed = await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, {
    self: true, signature: "Typed staff signature", staffRosterId: otherSiteStaff.data?.id,
    staffName: "Forged name",
  });
  check("linked staff renews only their own expired acknowledgement", renewed.status === 201 && renewed.data?.created === 1
    && renewed.data.records[0]?.staff_roster_id === staff.data?.id);
  const completedMine = await request("GET", "/doc-track/acknowledgements/my");
  check("renewal moves document to completed with its acknowledgement date",
    completedMine.status === 200
      && !completedMine.data?.pending?.some((item) => item.id === document.data?.id)
      && !!completedMine.data?.completed?.find((item) => item.id === document.data?.id)?.acknowledged_at);
  check("repeat self sign-off is idempotent",
    (await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, { self: true })).data?.created === 0);
  cookie = managerCookie;
  check("manager without a linked roster sees no personal records",
    (await request("GET", "/doc-track/acknowledgements/my")).data?.rosterLinked === false);
  check(
    "renewal creates a replacement TrainTrack sign-off",
    typeof renewed.data?.records?.[0]?.train_track_record_id === "number"
      && renewed.data.records[0].train_track_record_id !== trainRecordId,
  );

  overview = await request("GET", "/doc-track/acknowledgements/outstanding");
  overviewRow = overview.data?.documents?.find((item) => item.id === document.data?.id);
  check("renewed annual sign-off clears outstanding staff", overviewRow?.outstanding?.length === 0);
  listed = await request("GET", "/doc-track/documents");
  row = listed.data?.find((item) => item.id === document.data?.id);
  check("renewed annual acknowledgement is current", row?.acknowledgement_status === "acknowledged");

  const managerExport = await request("GET", `/doc-track/documents/${document.data?.id}/acknowledgements/export`);
  check("manager can export acknowledgement PDF", managerExport.status === 200);
  check("export is a PDF attachment", managerExport.contentType === "application/pdf"
    && managerExport.disposition?.includes("attachment")
    && managerExport.bytes?.subarray(0, 8).toString() === "%PDF-1.4");
  const pdfText = managerExport.bytes?.toString() ?? "";
  check("PDF contains document and acknowledged staff", pdfText.includes("Annual safety policy") && pdfText.includes("Alex Staff"));

  await execFile("psql", [
    process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
    `INSERT INTO doc_track_documents
      (client_id,site_id,title,category,file_name,mime_type,object_path,requires_acknowledgement,annual_acknowledgement,department)
     VALUES (${Number(clientId)},${Number(primarySite.data?.id)},'Combined register outstanding fixture','procedure','combined.pdf','application/pdf','fixtures/combined-register.pdf',true,false,'Kitchen')`,
  ]);
  const combinedExport = await request("GET", `/doc-track/acknowledgements/export?clientId=${Number(clientId)}`);
  check("manager can export a combined acknowledgement PDF",
    combinedExport.status === 200 && combinedExport.contentType === "application/pdf"
      && combinedExport.disposition?.includes('filename="document-acknowledgement-register.pdf"')
      && combinedExport.bytes?.subarray(0, 8).toString() === "%PDF-1.4");
  const combinedPdfText = combinedExport.bytes?.toString() ?? "";
  check("combined PDF contains separate sections for each required document",
    combinedPdfText.includes("Annual safety policy")
      && combinedPdfText.includes("Staff signoff fixture")
      && combinedPdfText.includes("Combined register outstanding fixture"));
  check("each register section includes its category and acknowledgement date range",
    combinedPdfText.includes("Category: policy")
      && combinedPdfText.includes("Category: procedure")
      && combinedPdfText.includes("Acknowledgement date range:")
      && combinedPdfText.includes("No acknowledgements recorded"));
  const outstandingSectionStart = combinedPdfText.indexOf("Combined register outstanding fixture");
  const nextSectionStart = combinedPdfText.indexOf("Section ", outstandingSectionStart + 1);
  const outstandingSection = combinedPdfText.slice(
    outstandingSectionStart,
    nextSectionStart === -1 ? undefined : nextSectionStart,
  );
  check("combined register separates acknowledged and outstanding staff per document",
    outstandingSection.includes("Alex Staff") && outstandingSection.includes("Outstanding")
      && !outstandingSection.includes("Other Site Staff")
      && !outstandingSection.includes("Other Department Staff")
      && !outstandingSection.includes("Former Staff"));

  const exportStaffEmail = `doc-export-staff-${Date.now()}@test.local`;
  const viewerEmail = `doc-export-viewer-${Date.now()}@test.local`;
  requireSuccess("create staff user", await request("POST", "/users", {
    name: "Export Staff", email: exportStaffEmail, password: "password-123", role: "client_staff", clientId,
  }), 201);
  requireSuccess("create viewer user", await request("POST", "/users", {
    name: "Export Viewer", email: viewerEmail, password: "password-123", role: "client_viewer", clientId,
  }), 201);

  cookie = "";
  requireSuccess("log in as staff", await request("POST", "/auth/login", { email: exportStaffEmail, password: "password-123" }), 200);
  check("staff cannot export aggregate acknowledgement PDF",
    (await request("GET", `/doc-track/documents/${document.data?.id}/acknowledgements/export`)).status === 403);
  check("staff cannot export the combined acknowledgement PDF",
    (await request("GET", `/doc-track/acknowledgements/export?clientId=${Number(clientId)}`)).status === 403);

  cookie = "";
  requireSuccess("log in as viewer", await request("POST", "/auth/login", { email: viewerEmail, password: "password-123" }), 200);
  check("viewer cannot export aggregate acknowledgement PDF",
    (await request("GET", `/doc-track/documents/${document.data?.id}/acknowledgements/export`)).status === 403);
  check("viewer cannot export the combined acknowledgement PDF",
    (await request("GET", `/doc-track/acknowledgements/export?clientId=${Number(clientId)}`)).status === 403);
  check("viewer cannot create TrainTrack records",
    (await request("POST", "/train-track/records", {
      recordType: "internal", staffName: "Viewer", trainingType: "Test",
      trainer: "Test", completedDate: isoDate(),
    })).status === 403);
  check("viewer cannot update TrainTrack records",
    (await request("PATCH", `/train-track/records/${manualTrainRecord.data?.id}`, { notes: "forged" })).status === 403);
  check("viewer cannot acknowledge a DocTrack document",
    (await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, { signature: "Viewer" })).status === 403);

  // DocTrack is a site-scoped PATCH handler: department-scoped staff may edit
  // metadata on an in-scope document, but cannot move it into another dept.
  cookie = managerCookie;
  requireSuccess("log in as site-scoped DocTrack staff", await request("POST", "/auth/login", {
    email: otherSiteStaff.data?.email, password: "password-123",
  }), 200);
  const staffDocPatch = await request("PATCH", `/doc-track/documents/${document.data?.id}`, {
    description: "Scoped staff metadata edit",
  });
  check("scoped staff can PATCH current DocTrack document", staffDocPatch.status === 200);
  const staffDocMove = await request("PATCH", `/doc-track/documents/${document.data?.id}`, {
    siteId: otherDepartmentSite.data?.id,
  });
  check("scoped staff cannot PATCH DocTrack site", staffDocMove.status === 403);
  cookie = managerCookie;
  const documentAfterMove = await request("GET", "/doc-track/documents");
  check("rejected DocTrack move keeps original site",
    documentAfterMove.data?.some?.((row) =>
      row.id === document.data?.id && row.site_id === primarySite.data?.id));
  const managerDocMove = await request("PATCH", `/doc-track/documents/${document.data?.id}`, {
    siteId: otherDepartmentSite.data?.id,
  });
  check("admin can PATCH DocTrack site", managerDocMove.status === 200);
  check("admin DocTrack move changes site", managerDocMove.data?.site_id === otherDepartmentSite.data?.id);

  // A record ID from another account must neither be visible nor mutable.
  cookie = "";
  const otherEmail = `doc-train-isolation-${Date.now()}@test.local`;
  const otherRegistered = await request("POST", "/auth/register", {
    name: "Other tenant", email: otherEmail, password: "password-123",
  });
  requireSuccess("register isolated tenant", otherRegistered, 200);
  requireSuccess("verify isolated tenant", await request(
    "GET", `/auth/verify-email?token=${encodeURIComponent(otherRegistered.data?.verificationToken)}`,
  ), 200);
  requireSuccess("log in isolated tenant", await request("POST", "/auth/login", {
    email: otherEmail, password: "password-123",
  }), 200);
  const isolatedRecords = await request("GET", "/train-track/records");
  requireSuccess("list isolated TrainTrack records", isolatedRecords, 200);
  check("other tenant cannot see TrainTrack record",
    !isolatedRecords.data?.some((record) => record.id === manualTrainRecord.data?.id));
  check("other tenant cannot update TrainTrack record",
    (await request("PATCH", `/train-track/records/${manualTrainRecord.data?.id}`, { notes: "forged" })).status === 404);
  check("other tenant cannot read DocTrack acknowledgements",
    (await request("GET", `/doc-track/documents/${document.data?.id}/acknowledgements`)).status === 404);
  check("other tenant cannot create DocTrack acknowledgement evidence",
    (await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, {
      acknowledgements: [{ staffRosterId: staff.data?.id, staffName: "forged" }],
    })).status === 404);
  check("other tenant's personal list cannot reveal the first tenant's documents",
    !(await request("GET", "/doc-track/acknowledgements/my")).data?.pending?.some((item) => item.id === document.data?.id));

  cookie = managerCookie;
  const preset = await request("PUT", "/pat-track/preset-templates/pest-control", {
    items: [{ name: "Electric ULV Fogger", type: "Portable Tool" }],
  });
  check("save pest-control PAT template", preset.status === 200 && preset.data?.ok === true);
  const presets = await request("GET", "/pat-track/preset-templates");
  check("read tenant pest-control PAT template", presets.status === 200 && Array.isArray(presets.data?.["pest-control"]));

  if (failures) process.exit(1);
  console.log("DocTrack status reconciliation and pest-control preset checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});