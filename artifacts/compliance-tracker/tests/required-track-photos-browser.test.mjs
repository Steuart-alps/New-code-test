import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
};
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test", REPL_ID: undefined },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLogs = "";
vite.stdout.on("data", chunk => { viteLogs += chunk.toString(); });
vite.stderr.on("data", chunk => { viteLogs += chunk.toString(); });
let browser;
let page;

const SITE = { id: 11, name: "Required Photo Test Site" };
const MACHINE = {
  id: 401,
  clientId: 42,
  siteId: SITE.id,
  siteName: SITE.name,
  name: "Required Photo Test Mower",
  type: "ride_on",
  make: "Fixture",
  model: "Mower",
  serialNo: "RP-401",
  year: 2024,
  regNo: "RP-401",
  active: true,
  notes: null,
};
const ENTITY_TYPES = [
  "green_pre_use_check",
  "green_service",
  "green_defect",
  "swim_session",
  "swim_surveillance_check",
  "swim_first_aid_check",
  "swim_incident",
];
const requirementRows = ENTITY_TYPES.map(entity_type => ({
  entity_type,
  required: true,
  min_photos: 2,
}));
const today = new Date().toISOString().slice(0, 10);

const collections = new Map([
  ["/api/green-track/pre-use-checks", [{
    id: 501, machineId: MACHINE.id, machineName: MACHINE.name, machineType: MACHINE.type,
    checkDate: today, operator: "Historical pre-use record", fluidLevelsOk: true, tyresOk: true,
    bladesOk: true, guardsOk: true, controlsOk: true, lightsOk: true, cleanlinessOk: true,
    defectNoted: false, result: "pass", notes: null, checklistItems: null, fuelLevel: null,
    submittedAt: null,
  }]],
  ["/api/green-track/service-records", [{
    id: 502, machineId: MACHINE.id, machineName: MACHINE.name, machineType: MACHINE.type,
    serviceDate: today, serviceType: "scheduled", hoursAtService: null, nextServiceHours: null,
    nextServiceDate: null, workPerformed: "Historical service record", servicedBy: null,
    servicedByRosterId: null, costPence: null, notes: null,
  }]],
  ["/api/green-track/defects", [{
    id: 503, machineId: MACHINE.id, machineName: MACHINE.name, machineType: MACHINE.type,
    reportDate: today, reportedBy: null, reportedByRosterId: null,
    description: "Historical GreenTrack defect", severity: "minor", outOfService: false,
    status: "open", resolution: null, resolvedDate: null, notes: null,
  }]],
  ["/api/swim-track/sessions", [{
    id: 601, siteId: SITE.id, siteName: SITE.name, sessionDate: today, sessionType: "public_swim",
    lifeguardName: "Historical session lifeguard", openTime: "09:00", closeTime: "17:00",
    maxBathers: 100, batherCountPeak: 20, preSessionResult: "pass", preSessionNotes: null,
    poolClosed: false, closureReason: null, notes: null, result: "pass",
  }]],
  ["/api/swim-track/surveillance", [{
    id: 602, sessionId: 601, siteId: SITE.id, siteName: SITE.name, checkDate: today,
    checkTime: "10:00", batherCount: 20, scanCompleted: true,
    observations: "Historical surveillance record", checkedBy: "Historical lifeguard", result: "pass",
  }]],
  ["/api/swim-track/first-aid", [{
    id: 603, siteId: SITE.id, siteName: SITE.name, checkDate: today,
    aedOk: true, firstAidKitOk: true, rescuePoleOk: true, throwBagOk: true,
    spineBoardOk: true, ringBuoyOk: true, oxygenKitOk: true,
    checkedBy: "Historical first-aid check", defectsFound: null, notes: null, result: "pass",
  }]],
  ["/api/swim-track/incidents", [{
    id: 604, siteId: SITE.id, siteName: SITE.name, incidentDate: today, incidentTime: null,
    incidentType: "near_miss", severity: "low", personsInvolved: null,
    description: "Historical SwimTrack incident", actionTaken: null, reportedTo: null,
    reportedDate: null, outcome: null, notes: null,
  }]],
]);

const createPaths = new Map([
  ["/api/green-track/pre-use-checks", "green_pre_use_check"],
  ["/api/green-track/service-records", "green_service"],
  ["/api/green-track/defects", "green_defect"],
  ["/api/swim-track/sessions", "swim_session"],
  ["/api/swim-track/surveillance", "swim_surveillance_check"],
  ["/api/swim-track/first-aid", "swim_first_aid_check"],
  ["/api/swim-track/incidents", "swim_incident"],
]);

const photosByEntity = new Map();
const stagedObjects = new Map();
const requestUploadBodies = [];
const requestUploadObjects = [];
const stagedReceiptBodies = [];
const photoMutationHeaders = [];
const storagePutHeaders = [];
const createRequests = [];
const updateRequests = [];
const requirementRequests = [];
const requirementResponses = [];
const unexpectedApiRequests = [];
let csrfTokenRequests = 0;
let nextRecordId = 7100;
let nextPhotoId = 9100;
let nextObjectId = 1;
let requirementFailureRemaining = 1;
let omittedRequirementTypes = new Set();
let nextStageFailure = null;
let delayNextStoragePut = false;

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=",
  "base64",
);
const jsonResponse = (route, data, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(data),
});
const photoKey = (entityType, entityId) => `${entityType}:${entityId}`;

function authFixture() {
  return {
    user: {
      id: 156,
      email: "required-track-photos@example.test",
      name: "Required Track Photos Browser Test",
      role: "client_admin",
      clientId: 42,
      departmentId: null,
      active: true,
      totpEnabled: true,
    },
    client: {
      id: 42,
      name: "Required Photo Fixture Client",
      slug: "required-photo-fixture-client",
      logoUrl: null,
      primaryColor: "#2F7C8C",
      active: true,
    },
    services: ["greentrack", "swimtrack"],
  };
}

async function csrfFailure(route, pathname) {
  const token = route.request().headers()["x-csrf-token"] ?? null;
  photoMutationHeaders.push({ pathname, token });
  if (token === "required-photo-test-csrf") return false;
  await jsonResponse(route, { error: "Missing or invalid photo/record CSRF token" }, 403);
  return true;
}

function storedPhoto(photo) {
  return {
    id: photo.id,
    entity_type: photo.entityType,
    entity_id: photo.entityId,
    object_path: photo.objectPath,
    caption: null,
    created_at: "2026-09-23T00:00:00.000Z",
  };
}

function makeCreatedRecord(pathname, body, id) {
  const shared = { id, ...body };
  if (pathname === "/api/green-track/pre-use-checks") {
    return {
      ...shared,
      machineName: MACHINE.name,
      machineType: MACHINE.type,
      checkDate: body.checkDate ?? today,
      submittedAt: null,
    };
  }
  if (pathname === "/api/green-track/service-records") {
    return { ...shared, machineName: MACHINE.name, machineType: MACHINE.type };
  }
  if (pathname === "/api/green-track/defects") {
    return { ...shared, machineName: MACHINE.name, machineType: MACHINE.type };
  }
  if (pathname === "/api/swim-track/sessions") {
    return { ...shared, siteName: SITE.name, sessionDate: body.sessionDate ?? today };
  }
  if (pathname === "/api/swim-track/surveillance") {
    return { ...shared, siteName: SITE.name, checkDate: body.checkDate ?? today };
  }
  if (pathname === "/api/swim-track/first-aid") {
    return { ...shared, siteName: SITE.name, checkDate: body.checkDate ?? today, result: "pass" };
  }
  return { ...shared, siteName: SITE.name, incidentDate: body.incidentDate ?? today };
}

async function routeApi(route, url) {
  const request = route.request();
  const { pathname, searchParams } = url;
  const method = request.method();

  if (pathname === "/api/auth/csrf-token" && method === "GET") {
    csrfTokenRequests += 1;
    return jsonResponse(route, { token: "required-photo-test-csrf" });
  }
  if (pathname === "/api/auth/me" && method === "GET") return jsonResponse(route, authFixture());
  if (pathname === "/api/billing/cancellation-status" && method === "GET") {
    return jsonResponse(route, { accessEndsAt: null });
  }
  if (pathname === "/api/sites" && method === "GET") return jsonResponse(route, [SITE]);
  if (pathname === "/api/staff-roster" && method === "GET") return jsonResponse(route, []);

  if (pathname === "/api/track-actions" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/track-actions/templates/matching" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/track-evidence" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/track-evidence/requirements" && method === "GET") return jsonResponse(route, []);

  if (pathname === "/api/photos/requirements" && method === "GET") {
    requirementRequests.push(url.toString());
    if (requirementFailureRemaining > 0) {
      requirementFailureRemaining -= 1;
      return jsonResponse(route, { error: "Required photo rules fixture temporarily unavailable" }, 503);
    }
    const rows = requirementRows.filter(row => !omittedRequirementTypes.has(row.entity_type));
    requirementResponses.push(rows);
    return jsonResponse(route, rows);
  }
  if (pathname === "/api/photos/request-staged-upload" && method === "POST") {
    if (await csrfFailure(route, pathname)) return;
    const body = request.postDataJSON();
    requestUploadBodies.push(body);
    const objectPath = `/required-track-photo-fixture/${body.entityType}/${nextObjectId++}.png`;
    const uploadUrl = `https://required-track-photo-storage.test/upload/${nextObjectId}`;
    requestUploadObjects.push({ body, objectPath });
    stagedObjects.set(objectPath, { entityType: body.entityType, name: body.name });
    return jsonResponse(route, { uploadUrl, objectPath });
  }
  if (pathname === "/api/photos/staged" && method === "POST") {
    if (await csrfFailure(route, pathname)) return;
    const body = request.postDataJSON();
    stagedReceiptBodies.push(body);
    if (nextStageFailure === "verification") {
      nextStageFailure = null;
      return jsonResponse(route, { error: "Staged photo verification fixture rejected" }, 503);
    }
    const id = `11111111-1111-4111-8111-${String(nextPhotoId++).padStart(12, "0")}`;
    const photo = { id, entityType: body.entityType, objectPath: body.objectPath };
    stagedObjects.set(body.objectPath, photo);
    return jsonResponse(route, { id, objectPath: body.objectPath });
  }
  if (pathname === "/api/photos" && method === "GET") {
    const entityType = searchParams.get("entityType");
    const entityId = searchParams.get("entityId");
    return jsonResponse(route, (photosByEntity.get(photoKey(entityType, entityId)) ?? []).map(storedPhoto));
  }
  if (pathname.startsWith("/api/storage/") && method === "GET") {
    return route.fulfill({ status: 200, contentType: "image/png", body: tinyPng });
  }

  if (createPaths.has(pathname) && method === "GET") {
    return jsonResponse(route, collections.get(pathname) ?? []);
  }
  if (pathname === "/api/green-track/machines" && method === "GET") return jsonResponse(route, [MACHINE]);
  if (pathname === "/api/green-track/status" && method === "GET") {
    return jsonResponse(route, {
      totalMachines: 1, activeMachines: 1, openDefects: 1, outOfService: 0,
      criticalDefects: 0, checkedTodayCount: 0, overdueService: 0,
    });
  }
  if (pathname === "/api/green-track/config" && method === "GET") {
    return jsonResponse(route, {
      green_default_operators: "[]",
      green_show_fuel: "true",
    });
  }
  if (pathname === "/api/swim-track/status" && method === "GET") {
    return jsonResponse(route, {
      sessionsToday: 1, poolsClosedToday: 0, surveillanceToday: 1,
      firstAidLast30d: 1, firstAidActionRequired: 0, lastFirstAidCheck: today, openIncidents: 1,
    });
  }
  if (pathname === "/api/photos" && method === "POST") {
    unexpectedApiRequests.push({ method, url: url.toString(), body: request.postData() ?? null });
    return jsonResponse(route, { error: "Staged evidence must only be attached with a record create request" }, 501);
  }

  if (createPaths.has(pathname) && method === "POST") {
    if (await csrfFailure(route, pathname)) return;
    const body = request.postDataJSON();
    const entityType = createPaths.get(pathname);
    const id = ++nextRecordId;
    const record = makeCreatedRecord(pathname, body, id);
    collections.set(pathname, [...(collections.get(pathname) ?? []), record]);
    createRequests.push({ pathname, entityType, body, id });

    const attachedPhotos = (body.photoUploadIds ?? []).map(photoId => {
      const staged = [...stagedObjects.values()].find(photo => photo.id === photoId);
      assert.ok(staged, `create ${entityType} must reference an accepted staged-photo receipt (${photoId})`);
      assert.equal(staged.entityType, entityType, "staged evidence must be scoped to the record's entity type");
      return {
        id: ++nextPhotoId,
        entityType,
        entityId: id,
        objectPath: staged.objectPath,
      };
    });
    photosByEntity.set(photoKey(entityType, id), attachedPhotos);
    return jsonResponse(route, record, 201);
  }

  const updateMatch = pathname.match(/^\/api\/(?:green-track|swim-track)\/[^/]+\/(\d+)$/);
  if (updateMatch && method === "PUT") {
    if (await csrfFailure(route, pathname)) return;
    const body = request.postDataJSON();
    updateRequests.push({ pathname, id: Number(updateMatch[1]), body });
    const recordPath = pathname.replace(/\/\d+$/, "");
    const rows = collections.get(recordPath) ?? [];
    const index = rows.findIndex(row => row.id === Number(updateMatch[1]));
    if (index >= 0) rows[index] = { ...rows[index], ...body };
    return jsonResponse(route, index >= 0 ? rows[index] : { id: Number(updateMatch[1]), ...body });
  }

  unexpectedApiRequests.push({
    method,
    url: url.toString(),
    body: request.postData() ?? null,
  });
  return jsonResponse(route, { error: `Unexpected test API request: ${method} ${pathname}` }, 501);
}

async function waitForVite() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited before startup:\n${viteLogs}`);
    try {
      const response = await fetch(`${baseUrl}/tests/required-track-photos-harness.html`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteLogs}`);
}

async function navigateHarness(pageName) {
  const response = await page.goto(
    `${baseUrl}/tests/required-track-photos-harness.html?page=${pageName}`,
    { waitUntil: "domcontentloaded" },
  );
  assert.ok(response?.ok(), `Required-photo harness navigation failed (${pageName}): ${response?.status() ?? "no response"}`);
}

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

async function uploadRequiredPhoto(dialog, entityType, ordinal) {
  const fileInput = dialog.locator('input[type="file"][aria-label="Select required photo"]');
  const requestCount = requestUploadBodies.length;
  const receiptCount = stagedReceiptBodies.length;
  const requestResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/photos/request-staged-upload",
  );
  const receiptResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/photos/staged",
  );
  const fileName = `required-${entityType}-${ordinal}.png`;
  await fileInput.setInputFiles({ name: fileName, mimeType: "image/png", buffer: tinyPng });
  assert.equal((await requestResponse).status(), 200);
  assert.equal((await receiptResponse).status(), 200);
  await dialog.getByText(`${ordinal}/2 required photos attached`, { exact: true }).waitFor({ state: "visible" });
  assert.equal(requestUploadBodies.length, requestCount + 1);
  assert.equal(stagedReceiptBodies.length, receiptCount + 1);
  assert.deepEqual(requestUploadBodies.at(-1), { entityType, name: fileName, contentType: "image/png" });
  assert.equal(stagedReceiptBodies.at(-1).entityType, entityType);
  assert.equal(stagedReceiptBodies.at(-1).objectPath, requestUploadObjects.at(-1).objectPath);
}

async function completeRequiredCreate({ entityType, path, saveLabel, marker, prepare }) {
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await prepare?.(dialog);
  assert.equal(await dialog.getByText("0/2 required photos attached", { exact: true }).count(), 1,
    `${entityType} new-record form should show its required minimum`);
  const save = dialog.getByRole("button", { name: saveLabel, exact: true });
  assert.equal(await save.isDisabled(), true, `${entityType} must not save before staged receipts`);
  const beforeCreates = createRequests.length;

  if (entityType === "green_pre_use_check") {
    nextStageFailure = "verification";
    delayNextStoragePut = true;
    const input = dialog.locator('input[type="file"][aria-label="Select required photo"]');
    const failureReceipt = page.waitForResponse(response =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/photos/staged",
    );
    await input.setInputFiles({ name: "failed-stage-green.png", mimeType: "image/png", buffer: tinyPng });
    await dialog.getByRole("button", { name: "Verifying photo…" }).waitFor({ state: "visible" });
    await dialog.getByText("0/2 required photos attached", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await save.isDisabled(), true, "an in-flight PUT must not count as an accepted receipt");
    assert.equal(createRequests.length, beforeCreates, "an upload in flight must not POST a record");
    assert.equal((await failureReceipt).status(), 503);
    await dialog.getByRole("alert").filter({ hasText: "Staged photo verification fixture rejected" }).waitFor({ state: "visible" });
    await dialog.getByText("0/2 required photos attached", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await save.isDisabled(), true, "a failed stage-verification request must not count toward the minimum");
    assert.equal(createRequests.length, beforeCreates, "a failed stage must not POST a record");
  }

  await uploadRequiredPhoto(dialog, entityType, 1);
  assert.equal(await save.isDisabled(), true, `${entityType} must remain blocked with only one verified photo`);
  await uploadRequiredPhoto(dialog, entityType, 2);
  assert.equal(await save.isDisabled(), false, `${entityType} becomes saveable at its configured minimum`);

  const countBeforePost = createRequests.length;
  const createResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === path,
  );
  const photoListResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/photos"
      && url.searchParams.get("entityType") === entityType;
  });
  await save.click();
  const response = await createResponse;
  assert.equal(response.status(), 201, `${entityType} record create should succeed`);
  assert.equal(createRequests.length, countBeforePost + 1);
  const created = createRequests.at(-1);
  assert.equal(created.entityType, entityType);
  assert.equal(created.pathname, path);
  assert.equal(created.body.photoUploadIds.length, 2, "record create should carry exactly the minimum verified upload IDs");
  assert.equal(new Set(created.body.photoUploadIds).size, 2, "record create should carry unique upload IDs");
  assert.ok(created.body.photoUploadIds.every(id => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)));
  assert.ok(Object.values(created.body).some(value => value === marker),
    `${entityType} create payload should retain its valid form data`);
  await dialog.waitFor({ state: "hidden" });

  const savedRow = entityType === "green_defect"
    ? page.getByText(marker, { exact: true }).last().locator("xpath=..")
    : page.locator("tr").filter({ hasText: marker }).last();
  await savedRow.waitFor({ state: "visible" });
  await savedRow.locator('img[alt="Check photo"]').first().waitFor({ state: "visible" });
  const photoResponse = await photoListResponse;
  assert.equal(photoResponse.status(), 200, "the saved row should reload its staged photo association");
  assert.equal(new URL(photoResponse.url()).searchParams.get("entityId"), String(created.id),
    "the saved row should request the photos belonging to its new record id");
  assert.ok((photosByEntity.get(photoKey(entityType, created.id)) ?? []).length === 2);
  return created;
}

async function selectMachine(dialog) {
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /Required Photo Test Mower/ }).click();
}

async function enterCustomPerformer(dialog, name) {
  const performer = dialog.locator('select[data-testid="select-performed-by"]');
  await performer.selectOption("__custom__");
  await dialog.locator('input[data-testid="input-performed-by-custom"]').fill(name);
}

async function openGreenTab(tab, buttonName) {
  await page.locator("main").getByRole("button", { name: new RegExp(`^${tab}(?:\\s+\\d+)?$`) }).click();
  await page.locator("main").getByRole("button", { name: buttonName, exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
}

async function openSwimTab(tab, toolbarButton) {
  await page.locator("main").getByRole("button", { name: new RegExp(`^${tab}(?:\\s+\\d+)?$`) }).click();
  await page.locator("main").getByRole("button", { name: toolbarButton, exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
}

try {
  await waitForVite();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on("pageerror", error => {
    pageErrors.push(error.message);
    console.error(`[browser:error] ${error.message}`);
  });
  page.on("console", message => {
    if (message.type() === "error") console.error(`[browser:console] ${message.text()}`);
  });

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "required-track-photo-storage.test" && request.method() === "PUT") {
      const csrf = request.headers()["x-csrf-token"] ?? null;
      storagePutHeaders.push(csrf);
      if (csrf !== null) {
        return jsonResponse(route, { error: "Session CSRF header must not be sent to object storage" }, 400);
      }
      if (delayNextStoragePut) {
        delayNextStoragePut = false;
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      return route.fulfill({ status: 200, body: "" });
    }
    if (isApiRequest(url)) return routeApi(route, url);
    return route.continue();
  });

  await navigateHarness("green");
  await page.getByRole("heading", { name: "GreenTrack", exact: true }).waitFor({ state: "visible" });

  // Requirements outages stay visible and block a new form until the user
  // explicitly retries the shared requirements query.
  const requirementErrorText = /(?:photo requirements could not be loaded|could not load photo requirements)/i;
  await page.getByRole("alert").filter({ hasText: requirementErrorText }).waitFor({ state: "visible" });
  for (const entityType of ENTITY_TYPES) {
    const cachedRule = requirementRows.find(row => row.entity_type === entityType);
    assert.equal(cachedRule?.required, true, `${entityType} is configured as photo-required`);
    assert.equal(cachedRule?.min_photos, 2, `${entityType} uses the two-photo minimum`);
  }
  await page.locator("main").getByRole("button", { name: "Pre-use", exact: true }).click();
  await page.locator("main").getByRole("button", { name: "Record check", exact: true }).click();
  const outageDialog = page.getByRole("dialog");
  await outageDialog.getByRole("alert").filter({ hasText: requirementErrorText }).waitFor({ state: "visible" });
  assert.equal(await outageDialog.getByRole("button", { name: "Record check", exact: true }).isDisabled(), true,
    "requirements outage must disable record creation");
  const requirementRetryResponse = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/photos/requirements",
  );
  await outageDialog.getByRole("button", { name: "Retry photo requirements" }).click();
  assert.equal((await requirementRetryResponse).status(), 200, "retry should reload the failed requirements request");
  await outageDialog.getByText("0/2 required photos attached", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(requirementResponses[0], requirementRows,
    "the shared requirements response should expose all seven snake-case required rules");
  assert.equal(await outageDialog.getByRole("button", { name: "Record check", exact: true }).isDisabled(), true,
    "retrying the rules query must not bypass the required-photo minimum");

  await selectMachine(outageDialog);
  await enterCustomPerformer(outageDialog, "Created pre-use evidence record");
  const preUse = await completeRequiredCreate({
    entityType: "green_pre_use_check",
    path: "/api/green-track/pre-use-checks",
    saveLabel: "Record check",
    marker: "Created pre-use evidence record",
  });

  // Editing a pre-existing historical row is not subjected to the new-record
  // photo gate and sends a normal update without staged IDs.
  await page.locator("main").getByRole("button", { name: "Pre-use", exact: true }).click();
  const oldPreUseRow = page.locator("tr").filter({ hasText: "Historical pre-use record" });
  await oldPreUseRow.getByRole("button").first().click();
  const editDialog = page.getByRole("dialog");
  await editDialog.waitFor({ state: "visible" });
  assert.equal(await editDialog.getByRole("group", { name: "Required photo evidence" }).count(), 0,
    "editing a historical record should not request new evidence");
  const editSave = editDialog.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await editSave.isDisabled(), false, "historical records remain editable without new photos");
  const updateResponse = page.waitForResponse(response =>
    response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/green-track/pre-use-checks/501`,
  );
  await editSave.click();
  assert.equal((await updateResponse).status(), 200);
  assert.equal(updateRequests.at(-1).body.photoUploadIds, undefined);

  await openGreenTab("Services", "Log service");
  const serviceDialog = page.getByRole("dialog");
  await selectMachine(serviceDialog);
  await enterCustomPerformer(serviceDialog, "Created service evidence record");
  await completeRequiredCreate({
    entityType: "green_service",
    path: "/api/green-track/service-records",
    saveLabel: "Log service",
    marker: "Created service evidence record",
  });

  await openGreenTab("Defects", "Report defect");
  const defectDialog = page.getByRole("dialog");
  await selectMachine(defectDialog);
  await defectDialog.getByPlaceholder("Describe the fault, damage, or safety concern…").fill("Created defect evidence record");
  await completeRequiredCreate({
    entityType: "green_defect",
    path: "/api/green-track/defects",
    saveLabel: "Report defect",
    marker: "Created defect evidence record",
  });

  await navigateHarness("swim");
  await page.getByRole("heading", { name: "SwimTrack", exact: true }).waitFor({ state: "visible" });
  assert.equal(requirementRequests.length >= 2, true, "both actual track pages should request shared photo requirements");

  await openSwimTab("Sessions", "Log session");
  const sessionDialog = page.getByRole("dialog");
  await enterCustomPerformer(sessionDialog, "Created swim session evidence record");
  await completeRequiredCreate({
    entityType: "swim_session",
    path: "/api/swim-track/sessions",
    saveLabel: "Log session",
    marker: "Created swim session evidence record",
  });

  await openSwimTab("Surveillance", "Log check");
  const surveillanceDialog = page.getByRole("dialog");
  await surveillanceDialog.locator("textarea").fill("Created surveillance evidence record");
  await completeRequiredCreate({
    entityType: "swim_surveillance_check",
    path: "/api/swim-track/surveillance",
    saveLabel: "Log check",
    marker: "Created surveillance evidence record",
  });

  await openSwimTab("First Aid", "Check equipment");
  const firstAidDialog = page.getByRole("dialog");
  await enterCustomPerformer(firstAidDialog, "Created first-aid evidence record");
  await completeRequiredCreate({
    entityType: "swim_first_aid_check",
    path: "/api/swim-track/first-aid",
    saveLabel: "Save check",
    marker: "Created first-aid evidence record",
  });

  await openSwimTab("Incidents", "Log incident");
  const incidentDialog = page.getByRole("dialog");
  await incidentDialog.getByPlaceholder("Describe what happened…").fill("Created incident evidence record");
  await completeRequiredCreate({
    entityType: "swim_incident",
    path: "/api/swim-track/incidents",
    saveLabel: "Log incident",
    marker: "Created incident evidence record",
  });

  // Omitted rows use the contract's optional default. The optional record is
  // still created in one step and carries no staged uploads.
  omittedRequirementTypes = new Set(["green_service"]);
  await navigateHarness("green");
  await page.getByRole("heading", { name: "GreenTrack", exact: true }).waitFor({ state: "visible" });
  await page.locator("main").getByRole("button", { name: "Services", exact: true }).click();
  await page.locator("main").getByRole("button", { name: "Log service", exact: true }).click();
  const optionalDialog = page.getByRole("dialog");
  await optionalDialog.waitFor({ state: "visible" });
  await selectMachine(optionalDialog);
  await enterCustomPerformer(optionalDialog, "Created optional service record");
  assert.equal(await optionalDialog.getByRole("group", { name: "Required photo evidence" }).count(), 0,
    "a type with no required-photo row remains optional");
  assert.equal(await optionalDialog.getByRole("button", { name: "Log service", exact: true }).isDisabled(), false);
  const stageRequestsBeforeOptional = requestUploadBodies.length;
  const optionalCreateResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/green-track/service-records",
  );
  await optionalDialog.getByRole("button", { name: "Log service", exact: true }).click();
  assert.equal((await optionalCreateResponse).status(), 201);
  assert.equal(requestUploadBodies.length, stageRequestsBeforeOptional, "optional creation should not start a photo upload");
  assert.deepEqual(createRequests.at(-1).body.photoUploadIds, []);
  assert.equal(createRequests.at(-1).entityType, "green_service");
  await page.locator("tr").filter({ hasText: "Created optional service record" }).waitFor({ state: "visible" });

  const requiredEntityCreates = createRequests.filter(record =>
    ENTITY_TYPES.includes(record.entityType) && record.body.photoUploadIds?.length === 2,
  );
  assert.equal(requiredEntityCreates.length, 7,
    "all seven GreenTrack and SwimTrack required entity types should complete a two-photo record create");
  assert.deepEqual(
    requiredEntityCreates.map(record => record.entityType).sort(),
    [...ENTITY_TYPES].sort(),
    "each required GreenTrack and SwimTrack entity type should be created once with two verified photos",
  );
  assert.ok(csrfTokenRequests > 0, "staged-photo and record POSTs should obtain a session CSRF token");
  assert.ok(photoMutationHeaders.length >= 16, "staged-photo and record mutation headers should be observed");
  for (const { pathname, token } of photoMutationHeaders) {
    assert.equal(token, "required-photo-test-csrf", `${pathname} must carry the shared CSRF token`);
  }
  assert.ok(storagePutHeaders.length >= 14, "required evidence should be transferred directly to fake object storage");
  assert.ok(storagePutHeaders.every(token => token === null), "object-storage PUTs must not receive the session CSRF header");
  assert.ok(requirementRequests.length >= 3, "requirements should be retried and reloaded for the optional case");
  assert.deepEqual(unexpectedApiRequests, [], `unexpected API requests must fail the browser test: ${JSON.stringify(unexpectedApiRequests)}`);
  assert.deepEqual(pageErrors, [], `the actual track pages must not throw: ${pageErrors.join("; ")}`);

  console.log("GreenTrack and SwimTrack required-photo regression checks passed.");
} catch (error) {
  console.error("Required track photos browser test failed:", error);
  if (unexpectedApiRequests.length) {
    console.error("Unexpected API requests:", JSON.stringify(unexpectedApiRequests, null, 2));
  }
  if (page) {
    console.error("Required-photo browser page:", page.url());
    console.error("Visible page text:", (await page.locator("body").innerText().catch(() => "")).slice(0, 5000));
  }
  if (viteLogs) console.error("Vite server logs:\n", viteLogs.slice(-12000));
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    if (vite.exitCode === null) {
      vite.kill("SIGTERM");
      await new Promise(resolve => {
        const forceKill = setTimeout(() => {
          if (vite.exitCode === null) vite.kill("SIGKILL");
          resolve();
        }, 3000);
        vite.once("exit", () => {
          clearTimeout(forceKill);
          resolve();
        });
      });
    }
  }
}