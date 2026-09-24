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

  console.log(`${assertions} fresh-schema HTTP assertions passed.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});