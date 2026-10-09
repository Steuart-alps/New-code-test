// HTTP-only smoke coverage for routes whose tables/columns must be present
// after applying runtime migrations to an otherwise blank database.
//
// The parent harness owns the disposable server/database and cleanup. This
// test intentionally neither imports the application DB nor uses object
// storage.

import assert from "node:assert/strict";

const BASE = process.env.API_BASE;
if (!BASE) {
  throw new Error("API_BASE is required and must point at the disposable local test API");
}
if (process.env.NODE_ENV !== "test") {
  throw new Error("NODE_ENV=test is required; refusing to run fresh-schema smoke tests otherwise");
}

let cookie = "";
let assertions = 0;

function responseContext(method, path, response) {
  return `${method} ${path}: status=${response.status}, response=${JSON.stringify(response.data)}`;
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`${method} ${path}: request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data };
}

function expectStatus(method, path, response, expected) {
  assertions++;
  assert.equal(response.status, expected, responseContext(method, path, response));
  return response.data;
}

function expect(method, path, response, condition, message) {
  assertions++;
  assert.ok(condition, `${message}; ${responseContext(method, path, response)}`);
}

async function main() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const password = "password-123";
  const email = `fresh-schema-${stamp}@test.local`;

  const registerPath = "/auth/register";
  const registered = await request("POST", registerPath, {
    name: "Fresh Schema Manager",
    email,
    password,
  });
  expectStatus("POST", registerPath, registered, 200);
  expect(
    "POST",
    registerPath,
    registered,
    typeof registered.data?.verificationToken === "string",
    "NODE_ENV=test registration must return a verification token",
  );

  const verifyPath = `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`;
  const verified = await request("GET", verifyPath);
  expectStatus("GET", verifyPath, verified, 200);

  const loginPath = "/auth/login";
  const loggedIn = await request("POST", loginPath, { email, password });
  expectStatus("POST", loginPath, loggedIn, 200);

  const sitePath = "/sites";
  const site = await request("POST", sitePath, {
    name: `Fresh Schema Site ${stamp}`,
    seedStarterChecks: false,
  });
  expectStatus("POST", sitePath, site, 201);
  expect("POST", sitePath, site, Number.isInteger(site.data?.id), "site creation must return an integer id");
  const siteId = site.data.id;

  const department = await request("POST", "/departments", { name: `Fresh Department ${stamp}` });
  expectStatus("POST", "/departments", department, 201);
  const day = new Date().toISOString().slice(0, 10);
  const departmentReportPath = `/reports/compliance?from=${day}&to=${day}&departmentId=${department.data.id}&siteId=${siteId}`;
  const departmentReport = await request("GET", departmentReportPath);
  expectStatus("GET", departmentReportPath, departmentReport, 200);
  expect(
    "GET", departmentReportPath, departmentReport,
    departmentReport.data?.sites?.length === 1
      && Array.isArray(departmentReport.data?.dailyChecklists)
      && Array.isArray(departmentReport.data?.moduleActivity),
    "department report must work on a freshly migrated schema",
  );

  // Staff roster
  const rosterPath = "/staff-roster";
  const emptyRoster = await request("GET", `${rosterPath}?siteId=${siteId}`);
  expectStatus("GET", `${rosterPath}?siteId=${siteId}`, emptyRoster, 200);
  expect("GET", `${rosterPath}?siteId=${siteId}`, emptyRoster, Array.isArray(emptyRoster.data), "staff roster list must be an array");

  const staff = await request("POST", rosterPath, {
    name: "Fresh Schema Chef",
    email: `fresh-schema-chef-${stamp}@test.local`,
    jobTitle: "Chef",
    department: "Kitchen",
    siteId,
  });
  expectStatus("POST", rosterPath, staff, 201);
  expect("POST", rosterPath, staff, Number.isInteger(staff.data?.id), "staff creation must return an integer id");

  const listedRoster = await request("GET", `${rosterPath}?siteId=${siteId}`);
  expectStatus("GET", `${rosterPath}?siteId=${siteId}`, listedRoster, 200);
  expect(
    "GET",
    `${rosterPath}?siteId=${siteId}`,
    listedRoster,
    Array.isArray(listedRoster.data) && listedRoster.data.some((row) => row.id === staff.data.id),
    "created staff member must appear in the roster list",
  );

  // The test server supplies a strict external storage fixture; SQL is real.
  const me = await request("GET", "/auth/me");
  expectStatus("GET", "/auth/me", me, 200);
  const clientId = (me.data.user ?? me.data).clientId;
  const documentsPath = "/doc-track/documents";
  const emptyDocuments = await request("GET", documentsPath);
  expectStatus("GET", documentsPath, emptyDocuments, 200);
  expect("GET", documentsPath, emptyDocuments, Array.isArray(emptyDocuments.data), "DocTrack list must be an array");

  const document = await request("POST", documentsPath, {
    title: `Fresh schema policy ${stamp}`,
    category: "policy",
    description: "Metadata-only runtime migration smoke record",
    fileName: `fresh-schema-${stamp}.pdf`,
    mimeType: "application/pdf",
    fileSize: null,
    objectPath: `/objects/uploads/tenant-${clientId}/schema-fixture.pdf`,
    siteId,
    uploadedBy: "Fresh Schema Manager",
    requiresAcknowledgement: false,
  });
  expectStatus("POST", documentsPath, document, 201);
  expect("POST", documentsPath, document, Number.isInteger(document.data?.id), "DocTrack creation must return an integer id");

  const listedDocuments = await request("GET", documentsPath);
  expectStatus("GET", documentsPath, listedDocuments, 200);
  expect(
    "GET",
    documentsPath,
    listedDocuments,
    Array.isArray(listedDocuments.data) && listedDocuments.data.some((row) => row.id === document.data.id),
    "created DocTrack document must appear in the document list",
  );

  // TrainTrack
  const trainingPath = "/train-track/records";
  const emptyTraining = await request("GET", trainingPath);
  expectStatus("GET", trainingPath, emptyTraining, 200);
  expect("GET", trainingPath, emptyTraining, Array.isArray(emptyTraining.data), "TrainTrack list must be an array");

  const completedDate = new Date().toISOString().slice(0, 10);
  const training = await request("POST", trainingPath, {
    recordType: "certificate",
    staffName: "Fresh Schema Chef",
    trainingType: "Fire Safety Awareness",
    provider: "Fresh Schema Training",
    completedDate,
    siteId,
    notes: "Runtime migration smoke record",
  });
  expectStatus("POST", trainingPath, training, 201);
  expect("POST", trainingPath, training, Number.isInteger(training.data?.id), "TrainTrack creation must return an integer id");

  const listedTraining = await request("GET", `${trainingPath}?siteId=${siteId}`);
  expectStatus("GET", `${trainingPath}?siteId=${siteId}`, listedTraining, 200);
  expect(
    "GET",
    `${trainingPath}?siteId=${siteId}`,
    listedTraining,
    Array.isArray(listedTraining.data) && listedTraining.data.some((row) => row.id === training.data.id),
    "created TrainTrack record must appear in the record list",
  );

  // KitchenTrack weekly reviews
  const weeklyPath = "/kitchen-weekly/weekly";
  const emptyWeekly = await request("GET", `${weeklyPath}?siteId=${siteId}`);
  expectStatus("GET", `${weeklyPath}?siteId=${siteId}`, emptyWeekly, 200);
  expect("GET", `${weeklyPath}?siteId=${siteId}`, emptyWeekly, Array.isArray(emptyWeekly.data), "weekly review list must be an array");

  const weekly = await request("POST", weeklyPath, {
    weekCommencing: completedDate,
    siteId,
    checks: { temperatureControl: "yes", cleaning: "yes" },
    managerSignature: "Fresh Schema Manager",
  });
  expectStatus("POST", weeklyPath, weekly, 201);
  expect("POST", weeklyPath, weekly, Number.isInteger(weekly.data?.id), "weekly review creation must return an integer id");

  const listedWeekly = await request("GET", `${weeklyPath}?siteId=${siteId}`);
  expectStatus("GET", `${weeklyPath}?siteId=${siteId}`, listedWeekly, 200);
  expect(
    "GET",
    `${weeklyPath}?siteId=${siteId}`,
    listedWeekly,
    Array.isArray(listedWeekly.data) && listedWeekly.data.some((row) => row.id === weekly.data.id),
    "created weekly review must appear in the weekly list",
  );

  // KitchenTrack probe checks
  const probePath = "/kitchen-weekly/probe";
  const emptyProbes = await request("GET", `${probePath}?siteId=${siteId}`);
  expectStatus("GET", `${probePath}?siteId=${siteId}`, emptyProbes, 200);
  expect("GET", `${probePath}?siteId=${siteId}`, emptyProbes, Array.isArray(emptyProbes.data), "probe check list must be an array");

  const probe = await request("POST", probePath, {
    checkDate: completedDate,
    siteId,
    probes: [{
      name: "Blue probe",
      serialNo: `BLUE-${stamp}`,
      iceTemp: "0.2",
      boilingTemp: "99.8",
      accurateIce: true,
      accurateBoiling: true,
    }],
    overallResult: "pass",
    checkedByRosterId: staff.data.id,
    checkedBy: "Fresh Schema Chef",
  });
  expectStatus("POST", probePath, probe, 201);
  expect("POST", probePath, probe, Number.isInteger(probe.data?.id), "probe check creation must return an integer id");

  const listedProbes = await request("GET", `${probePath}?siteId=${siteId}`);
  expectStatus("GET", `${probePath}?siteId=${siteId}`, listedProbes, 200);
  expect(
    "GET",
    `${probePath}?siteId=${siteId}`,
    listedProbes,
    Array.isArray(listedProbes.data) && listedProbes.data.some((row) => row.id === probe.data.id),
    "created probe check must appear in the probe list",
  );

  // Compliance register: the list annotates each item with the latest related
  // certificate expiry, so it reads the legacy `certificates` table even when
  // no certificate exists. Cover empty history, a tenant-owned certificate and
  // a foreign tenant's certificate that must never leak into this register.
  const tenantCookie = cookie;
  const compliancePath = "/compliance-items";
  const contractorPath = "/contractors";
  const contractor = await request("POST", contractorPath, {
    name: "Fresh Schema Electrical",
    email: `fresh-schema-contractor-${stamp}@test.local`,
  });
  expectStatus("POST", contractorPath, contractor, 201);

  const uncertifiedItem = await request("POST", compliancePath, {
    title: `Fresh schema uncertified item ${stamp}`,
    siteId,
    contractorId: contractor.data.id,
  });
  expectStatus("POST", compliancePath, uncertifiedItem, 201);

  const emptyHistoryRegister = await request("GET", compliancePath);
  expectStatus("GET", compliancePath, emptyHistoryRegister, 200);
  const emptyHistoryRow = Array.isArray(emptyHistoryRegister.data)
    ? emptyHistoryRegister.data.find((row) => row.id === uncertifiedItem.data.id)
    : undefined;
  expect(
    "GET", compliancePath, emptyHistoryRegister,
    emptyHistoryRow && emptyHistoryRow.latestCertExpiryDate === null,
    "an item without certificate history must list with a null latest certificate expiry",
  );

  const certifiedItem = await request("POST", compliancePath, { title: `Fresh schema certified item ${stamp}`, siteId });
  expectStatus("POST", compliancePath, certifiedItem, 201);
  const ownCertificatesPath = `/items/${certifiedItem.data.id}/certificates`;
  const ownFileUrl = `/objects/uploads/tenant-${clientId}/schema-fixture.pdf`;
  const ownCertificate = await request("POST", ownCertificatesPath, {
    name: "Fresh schema EICR",
    fileUrl: ownFileUrl,
    issueDate: "2026-01-15T00:00:00.000Z",
    expiryDate: "2031-01-15T00:00:00.000Z",
    notes: "Tenant-owned evidence",
  });
  expectStatus("POST", ownCertificatesPath, ownCertificate, 201);
  expect(
    "POST", ownCertificatesPath, ownCertificate,
    ownCertificate.data?.itemId === certifiedItem.data.id
      && ownCertificate.data?.contractorId === null
      && ownCertificate.data?.fileUrl === ownFileUrl
      && ownCertificate.data?.notes === "Tenant-owned evidence",
    "item certificate must keep its owner and evidence metadata",
  );
  const ownCertificates = await request("GET", ownCertificatesPath);
  expectStatus("GET", ownCertificatesPath, ownCertificates, 200);
  expect(
    "GET", ownCertificatesPath, ownCertificates,
    Array.isArray(ownCertificates.data) && ownCertificates.data.length === 1
      && ownCertificates.data[0].fileUrl === ownFileUrl,
    "item certificate history must return the saved certificate",
  );

  // A second, unrelated tenant with a later-expiring certificate.
  cookie = "";
  const foreignEmail = `fresh-schema-foreign-${stamp}@test.local`;
  const foreignRegistered = await request("POST", registerPath, {
    name: "Fresh Schema Foreign Manager",
    email: foreignEmail,
    password,
  });
  expectStatus("POST", registerPath, foreignRegistered, 200);
  const foreignVerifyPath = `/auth/verify-email?token=${encodeURIComponent(foreignRegistered.data?.verificationToken)}`;
  expectStatus("GET", foreignVerifyPath, await request("GET", foreignVerifyPath), 200);
  expectStatus("POST", loginPath, await request("POST", loginPath, { email: foreignEmail, password }), 200);
  const foreignMe = await request("GET", "/auth/me");
  expectStatus("GET", "/auth/me", foreignMe, 200);
  const foreignClientId = (foreignMe.data.user ?? foreignMe.data).clientId;
  expect(
    "GET", "/auth/me", foreignMe,
    Number.isInteger(foreignClientId) && foreignClientId !== clientId,
    "the second registration must belong to a separate tenant",
  );

  const foreignItem = await request("POST", compliancePath, { title: `Fresh schema foreign item ${stamp}` });
  expectStatus("POST", compliancePath, foreignItem, 201);
  const foreignCertificatesPath = `/items/${foreignItem.data.id}/certificates`;
  const foreignFileUrl = `/objects/uploads/tenant-${foreignClientId}/schema-fixture.pdf`;
  const foreignCertificate = await request("POST", foreignCertificatesPath, {
    name: "Foreign tenant certificate",
    fileUrl: foreignFileUrl,
    expiryDate: "2039-06-30T00:00:00.000Z",
    notes: "Foreign tenant evidence",
  });
  expectStatus("POST", foreignCertificatesPath, foreignCertificate, 201);

  // The foreign tenant can neither read nor add to the first tenant's history.
  expectStatus("GET", ownCertificatesPath, await request("GET", ownCertificatesPath), 404);
  expectStatus("POST", ownCertificatesPath, await request("POST", ownCertificatesPath, {
    name: "Cross-tenant write",
    expiryDate: "2045-01-01T00:00:00.000Z",
  }), 404);
  const foreignRegister = await request("GET", compliancePath);
  expectStatus("GET", compliancePath, foreignRegister, 200);
  // Registration seeds starter items, so assert on ownership, not counts.
  const foreignRows = Array.isArray(foreignRegister.data) ? foreignRegister.data : [];
  expect(
    "GET", compliancePath, foreignRegister,
    foreignRows.length > 0
      && foreignRows.every((row) => row.clientId === foreignClientId)
      && foreignRows.find((row) => row.id === foreignItem.data.id)?.latestCertExpiryDate === "2039-06-30T00:00:00.000Z"
      && !foreignRows.some((row) => row.id === certifiedItem.data.id || row.id === uncertifiedItem.data.id),
    "the foreign tenant register must contain only its own items and certificate expiry",
  );

  cookie = tenantCookie;
  expectStatus("GET", foreignCertificatesPath, await request("GET", foreignCertificatesPath), 404);
  const tenantRegister = await request("GET", compliancePath);
  expectStatus("GET", compliancePath, tenantRegister, 200);
  const tenantRows = Array.isArray(tenantRegister.data) ? tenantRegister.data : [];
  const registerById = new Map(tenantRows.map((row) => [row.id, row]));
  expect(
    "GET", compliancePath, tenantRegister,
    tenantRows.every((row) => row.clientId === clientId)
      && registerById.get(uncertifiedItem.data.id)?.latestCertExpiryDate === null
      && registerById.get(certifiedItem.data.id)?.latestCertExpiryDate === "2031-01-15T00:00:00.000Z"
      && !registerById.has(foreignItem.data.id),
    "the register must show only this tenant's items and certificate expiries",
  );
  const serializedRegister = JSON.stringify(tenantRegister.data);
  expect(
    "GET", compliancePath, tenantRegister,
    !serializedRegister.includes("2039-06-30")
      && !serializedRegister.includes(foreignFileUrl)
      && !serializedRegister.includes("Foreign tenant"),
    "foreign tenant certificate metadata must not appear in the register",
  );

  console.log(`${assertions} fresh-schema HTTP assertions passed.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});