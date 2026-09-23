// End-to-end coverage for DocTrack's current acknowledgement status and the
// Pest Control PAT preset's tenant-scoped template API.
import { skipWhenStorageUnavailable } from "./storage-test-availability.mjs";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
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

  const renewed = await request("POST", `/doc-track/documents/${document.data?.id}/acknowledge`, {
    acknowledgements: [{ staffRosterId: staff.data?.id, staffName: "Alex Staff" }],
  });
  check("renew expired annual acknowledgement", renewed.status === 201 && renewed.data?.created === 1);
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

  const staffEmail = `doc-export-staff-${Date.now()}@test.local`;
  const viewerEmail = `doc-export-viewer-${Date.now()}@test.local`;
  requireSuccess("create staff user", await request("POST", "/users", {
    name: "Export Staff", email: staffEmail, password: "password-123", role: "client_staff", clientId,
  }), 201);
  requireSuccess("create viewer user", await request("POST", "/users", {
    name: "Export Viewer", email: viewerEmail, password: "password-123", role: "client_viewer", clientId,
  }), 201);

  cookie = "";
  requireSuccess("log in as staff", await request("POST", "/auth/login", { email: staffEmail, password: "password-123" }), 200);
  check("staff cannot export aggregate acknowledgement PDF",
    (await request("GET", `/doc-track/documents/${document.data?.id}/acknowledgements/export`)).status === 403);

  cookie = "";
  requireSuccess("log in as viewer", await request("POST", "/auth/login", { email: viewerEmail, password: "password-123" }), 200);
  check("viewer cannot export aggregate acknowledgement PDF",
    (await request("GET", `/doc-track/documents/${document.data?.id}/acknowledgements/export`)).status === 403);
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