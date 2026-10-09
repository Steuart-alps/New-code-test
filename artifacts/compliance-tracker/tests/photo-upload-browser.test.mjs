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

const safeRisk = {
  id: 8101,
  title: "Photo fixture — risk assessment",
  description: "Browser fixture",
  assessedBy: "Photo test auditor",
  reviewDate: "2027-06-01",
  status: "published",
  version: "1",
  siteId: 11,
  requiresAcknowledgement: false,
  createdAt: "2026-09-23T00:00:00.000Z",
};

const diaryId = 8202;
const diarySupplier = "Photo Fixture Dairy Supplier";
const bikeHires = [
  {
    id: 8301,
    bikeId: 301,
    bikeRef: "PHOTO-BIKE-A",
    bikeName: "First photo test bike",
    bikeType: "hybrid",
    guestName: "Photo Fixture Guest Alpha",
    guestContact: null,
    hireDate: "2026-09-23",
    returnDateExpected: "2026-09-24",
    returnDateActual: "2026-09-24",
    depositPence: null,
    depositReturned: false,
    status: "returned",
    notes: null,
    preCheckId: 8401,
    preResult: "pass",
    postCheckId: 8402,
    postResult: "pass",
    createdAt: "2026-09-23T00:00:00.000Z",
  },
  {
    id: 8302,
    bikeId: 302,
    bikeRef: "PHOTO-BIKE-B",
    bikeName: "Second photo test bike",
    bikeType: "road",
    guestName: "Photo Fixture Guest Beta",
    guestContact: null,
    hireDate: "2026-09-23",
    returnDateExpected: "2026-09-25",
    returnDateActual: "2026-09-25",
    depositPence: null,
    depositReturned: false,
    status: "returned",
    notes: null,
    preCheckId: 8501,
    preResult: "pass",
    postCheckId: 8502,
    postResult: "pass",
    createdAt: "2026-09-23T00:00:00.000Z",
  },
];

const photosByEntity = new Map();
const requestUploadBodies = [];
const photoAssociationBodies = [];
const photoGetRequests = [];
const photoMutationHeaders = [];
const storagePutHeaders = [];
const unexpectedApiRequests = [];
let csrfTokenRequests = 0;
let nextPhotoFailure = null;
let photoListUnavailable = false;
let nextPhotoId = 1;
let nextObjectId = 1;

const jsonResponse = (route, data, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(data),
});

const photoKey = (entityType, entityId) => `${entityType}:${entityId}`;
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=",
  "base64",
);

async function waitForVite() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited before startup:\n${viteLogs}`);
    try {
      const response = await fetch(`${baseUrl}/tests/photo-upload-harness.html`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteLogs}`);
}

function authFixture() {
  return {
    user: {
      id: 156,
      email: "photo-upload@example.test",
      name: "Photo Upload Browser Test",
      role: "client_admin",
      clientId: 42,
      departmentId: null,
      active: true,
      totpEnabled: true,
    },
    client: {
      id: 42,
      name: "Photo Fixture Client",
      slug: "photo-fixture-client",
      logoUrl: null,
      primaryColor: "#2F7C8C",
      active: true,
    },
    services: ["safetrack", "kitchentrack", "biketrack"],
  };
}

async function requirePhotoCsrf(route, pathname) {
  const token = route.request().headers()["x-csrf-token"] ?? null;
  photoMutationHeaders.push({ pathname, token });
  if (token !== "photo-test-csrf") {
    await jsonResponse(route, { error: "Missing or invalid photo CSRF token" }, 403);
    return true;
  }
  return false;
}

async function routeApi(route, url) {
  const request = route.request();
  const { pathname, searchParams } = url;
  const method = request.method();

  if (pathname === "/api/auth/csrf-token" && method === "GET") {
    csrfTokenRequests += 1;
    return jsonResponse(route, { token: "photo-test-csrf" });
  }
  if (pathname === "/api/auth/me" && method === "GET") return jsonResponse(route, authFixture());
  if (pathname === "/api/billing/cancellation-status" && method === "GET") {
    // AppLayout's admin-only subscription banner checks this status on mount.
    return jsonResponse(route, { accessEndsAt: null });
  }
  if (pathname === "/api/sites" && method === "GET") {
    return jsonResponse(route, [{ id: 11, name: "Photo Test Site" }]);
  }

  if (pathname.startsWith("/api/safe-track/") && method === "GET") {
    const dataByPath = {
      "/api/safe-track/risk-assessments": [safeRisk],
      "/api/safe-track/sops": [],
      "/api/safe-track/handbook": [],
      "/api/safe-track/training-records": [],
      "/api/safe-track/inductions": [],
    };
    if (Object.hasOwn(dataByPath, pathname)) return jsonResponse(route, dataByPath[pathname]);
  }

  if (pathname === "/api/food-safety/config" && method === "GET") {
    return jsonResponse(route, {
      food_show_deliveries: "true",
      food_show_cold_food: "true",
      food_show_hot_temperature: "true",
      food_show_cooling: "true",
      food_show_reheating: "true",
      food_show_hot_holding: "true",
      food_show_sous_vide: "true",
    });
  }
  if (pathname === "/api/food-safety/status" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/food-safety" && method === "GET") {
    return jsonResponse(route, [{
      id: diaryId,
      recordDate: new Date().toISOString().slice(0, 10),
      submittedAt: null,
    }]);
  }
  if (/^\/api\/food-safety\/by-date\/\d{4}-\d{2}-\d{2}$/.test(pathname) && method === "GET") {
    const recordDate = pathname.split("/").at(-1);
    return jsonResponse(route, {
      id: diaryId,
      recordDate,
      submittedAt: null,
      managerSignature: "Photo test manager",
      deliveries: [{
        supplier: diarySupplier,
        items: "Milk and cream",
        vanClean: "yes",
        rawCookedSep: "yes",
        tempChilled: "4",
        tempFrozen: "-18",
        tempOk: "yes",
        conditionOk: "yes",
        dateCodesOk: "yes",
        allergyAware: "yes",
        correctiveActions: "",
      }],
      coldFood: [],
      hotTemperature: [],
      cooking: [],
      cooling: [],
      reheating: [],
      hotHolding: [],
      sousVide: [],
      correctives: "",
    });
  }
  if (pathname === "/api/food-safety/summary" && method === "GET") return jsonResponse(route, { days: [] });

  if (pathname === "/api/bike-track/bikes" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/bike-track/hires" && method === "GET") {
    const status = searchParams.get("status");
    return jsonResponse(route, bikeHires.filter(hire => !status || hire.status === status));
  }
  if (pathname === "/api/bike-track/summary" && method === "GET") {
    return jsonResponse(route, {
      bikes: { available: 2, hired: 0, maintenance: 0, retired: 0, total: 2 },
      hires: { active_hires: 0, overdue: 0 },
      services: { overdue_service: 0 },
    });
  }
  if (pathname === "/api/bike-track/services" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/bike-track/services/latest" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/bike-track/config" && method === "GET") {
    return jsonResponse(route, {
      bike_default_deposit_pence: "",
      bike_hire_duration_hours: "",
      bike_require_helmet: "false",
      bike_overdue_repeat_interval_days: "0",
    });
  }
  if (pathname === "/api/form-options" && method === "GET") {
    return jsonResponse(route, { options: { bike_types: ["hybrid", "road"] }, defaults: {}, disabled: {}, customised: {} });
  }

  if (pathname === "/api/photos" && method === "GET") {
    const entityType = searchParams.get("entityType");
    const entityId = searchParams.get("entityId");
    photoGetRequests.push({ entityType, entityId });
    if (photoListUnavailable) {
      return jsonResponse(route, { error: "Photo list unavailable" }, 503);
    }
    return jsonResponse(route, photosByEntity.get(photoKey(entityType, entityId)) ?? []);
  }
  if (pathname === "/api/photos/request-upload" && method === "POST") {
    const csrfFailure = await requirePhotoCsrf(route, pathname);
    if (csrfFailure) return csrfFailure;
    const body = request.postDataJSON();
    requestUploadBodies.push(body);
    if (nextPhotoFailure === "presign") {
      nextPhotoFailure = null;
      return jsonResponse(route, { error: "Presigned upload unavailable" }, 503);
    }
    const objectPath = `/photo-upload-browser/${body.entityType}/${body.entityId}/${nextObjectId++}.png`;
    return jsonResponse(route, {
      uploadUrl: `https://photo-storage.test/upload/${nextObjectId}`,
      objectPath,
    });
  }
  if (pathname === "/api/photos" && method === "POST") {
    const csrfFailure = await requirePhotoCsrf(route, pathname);
    if (csrfFailure) return csrfFailure;
    const body = request.postDataJSON();
    photoAssociationBodies.push(body);
    if (nextPhotoFailure === "association") {
      nextPhotoFailure = null;
      return jsonResponse(route, { error: "Photo association rejected" }, 503);
    }
    const photo = {
      id: nextPhotoId++,
      entity_type: body.entityType,
      entity_id: body.entityId,
      object_path: body.objectPath,
      caption: null,
      created_at: "2026-09-23T00:00:00.000Z",
    };
    const key = photoKey(body.entityType, body.entityId);
    photosByEntity.set(key, [...(photosByEntity.get(key) ?? []), photo]);
    return jsonResponse(route, photo, 201);
  }
  if (pathname.startsWith("/api/storage/") && method === "GET") {
    return route.fulfill({ status: 200, contentType: "image/png", body: tinyPng });
  }

  unexpectedApiRequests.push({
    method,
    url: url.toString(),
    body: request.postData() ?? null,
  });
  return jsonResponse(route, { error: `Unexpected test API request: ${method} ${pathname}` }, 501);
}

function expectedPhotoBody(entityType, entityId) {
  return { entityType, entityId, name: "photo-regression.png", contentType: "image/png" };
}

function expectedAssociationBody(entityType, entityId, objectPath) {
  return { entityType, entityId, objectPath };
}

async function setPhotoFile(input) {
  await input.setInputFiles({
    name: "photo-regression.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
}

async function waitForToast(title) {
  await page.getByText(title, { exact: true }).waitFor({ state: "visible" });
}

async function uploadAndAssert(input, scope, entityType, entityId) {
  const uploadCountBefore = requestUploadBodies.length;
  const associationCountBefore = photoAssociationBodies.length;
  const associationResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/photos",
  );
  const photoReloadResponse = page.waitForResponse(response => {
    const request = response.request();
    const url = new URL(response.url());
    return request.method() === "GET"
      && url.pathname === "/api/photos"
      && url.searchParams.get("entityType") === entityType
      && url.searchParams.get("entityId") === String(entityId);
  });
  await setPhotoFile(input);
  assert.equal((await associationResponse).status(), 201, "successful photo association should return a created response");
  assert.equal((await photoReloadResponse).status(), 200, "the uploader should reload the persisted photos list");
  await waitForToast("Photo added");

  assert.equal(requestUploadBodies.length, uploadCountBefore + 1, "each upload should request one presigned URL");
  const requestBody = requestUploadBodies.at(-1);
  assert.deepEqual(
    requestBody,
    expectedPhotoBody(entityType, entityId),
    "request-upload must use the record represented by the visible page row/section",
  );
  assert.equal(photoAssociationBodies.length, associationCountBefore + 1, "each successful upload should create one photo association");
  const association = photoAssociationBodies.at(-1);
  assert.equal(association.entityType, entityType);
  assert.equal(association.entityId, entityId);
  assert.match(association.objectPath, new RegExp(`/${entityType}/${entityId}/`));
  assert.deepEqual(association, expectedAssociationBody(entityType, entityId, association.objectPath));
  // Thumbnails are decorative (alt=""); each photo's named control carries its label.
  await scope.getByRole("button", { name: /^View photo \d+ of \d+$/ }).first().waitFor({ state: "visible" });
  return association;
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
  page.on("console", message => {
    if (message.type() === "warning" || message.type() === "error") {
      console.error(`[browser:${message.type()}] ${message.text()}`);
    }
  });
  page.on("pageerror", error => {
    pageErrors.push(error.message);
    console.error(`[browser:error] ${error.message}`);
  });

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "photo-storage.test" && request.method() === "PUT") {
      const csrfHeader = request.headers()["x-csrf-token"] ?? null;
      storagePutHeaders.push(csrfHeader);
      if (csrfHeader !== null) {
        return jsonResponse(route, { error: "Session CSRF header must not be sent to object storage" }, 400);
      }
      if (nextPhotoFailure === "storage-put") {
        nextPhotoFailure = null;
        return route.fulfill({ status: 500, body: "Storage fixture failure" });
      }
      return route.fulfill({ status: 200, body: "" });
    }
    if (url.pathname.startsWith("/api/")) return routeApi(route, url);
    return route.continue();
  });

  const navigateHarness = async pageName => {
    const response = await page.goto(`${baseUrl}/tests/photo-upload-harness.html?page=${pageName}`, {
      waitUntil: "domcontentloaded",
    });
    assert.ok(response?.ok(), `Photo upload harness navigation failed (${pageName}): ${response?.status() ?? "no response"}`);
  };

  // SafeTrack's regular /safe-track page redirects to DocTrack. Mount its actual
  // component in the test-only harness rather than changing production routing.
  photoListUnavailable = true;
  await navigateHarness("safe");
  const safeRow = page.getByRole("row").filter({ hasText: safeRisk.title });
  await safeRow.waitFor({ state: "visible" });
  const safeInput = safeRow.locator('input[type="file"]');
  assert.equal(await safeInput.count(), 1, "SafeTrack's real risk-assessment row should own its photo input");
  const safeExpected = { entityType: "safe_risk_assessment", entityId: safeRisk.id };
  const photoListError = safeRow.getByRole("alert");
  await photoListError.waitFor({ state: "visible" });
  assert.match(await photoListError.innerText(), /Photo list unavailable/);
  photoListUnavailable = false;
  const retryListResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === "/api/photos"
      && url.searchParams.get("entityId") === String(safeRisk.id);
  });
  await safeRow.getByRole("button", { name: "Retry photos" }).click();
  assert.equal((await retryListResponse).status(), 200);
  await photoListError.waitFor({ state: "hidden" });

  for (const failure of ["presign", "storage-put", "association"]) {
    nextPhotoFailure = failure;
    const uploadsBeforeFailure = requestUploadBodies.length;
    const associationsBeforeFailure = photoAssociationBodies.length;
    const putsBeforeFailure = storagePutHeaders.length;
    await setPhotoFile(safeInput);
    await waitForToast("Upload failed");
    await safeRow.getByText(safeRisk.title, { exact: true }).waitFor({ state: "visible" });

    assert.equal(requestUploadBodies.length, uploadsBeforeFailure + 1, `${failure} failure must still request the URL for the SafeTrack row`);
    assert.deepEqual(requestUploadBodies.at(-1), expectedPhotoBody(safeExpected.entityType, safeExpected.entityId));
    const expectedPutCount = failure === "presign" ? 0 : 1;
    assert.equal(storagePutHeaders.length, putsBeforeFailure + expectedPutCount, `${failure} should fail at its intended upload stage`);
    const expectedAssociationCount = failure === "association" ? 1 : 0;
    assert.equal(photoAssociationBodies.length, associationsBeforeFailure + expectedAssociationCount);
    if (expectedAssociationCount) {
      const failedAssociation = photoAssociationBodies.at(-1);
      assert.equal(failedAssociation.entityType, safeExpected.entityType);
      assert.equal(failedAssociation.entityId, safeExpected.entityId);
    }

    // Retrying the same real input on the still-rendered row must keep the
    // record association, even after a failure at each upload stage.
    await uploadAndAssert(safeInput, safeRow, safeExpected.entityType, safeExpected.entityId);
  }

  assert.ok(
    photoGetRequests.some(get => get.entityType === safeExpected.entityType && get.entityId === String(safeExpected.entityId)),
    "SafeTrack's risk row should reload photos for its own entity/id and render the persisted thumbnail",
  );

  await navigateHarness("kitchen");
  const supplierInput = page.getByPlaceholder("Supplier", { exact: true });
  await supplierInput.waitFor({ state: "visible" });
  assert.equal(await supplierInput.inputValue(), diarySupplier, "KitchenTrack should load the existing diary record");
  await page.getByText("Recent Records", { exact: true }).waitFor({ state: "visible" });
  const kitchenMain = page.locator("main");
  const kitchenInput = kitchenMain.locator('input[type="file"]');
  assert.equal(await kitchenInput.count(), 1, "KitchenTrack's existing diary form should own its photo input");
  await uploadAndAssert(kitchenInput, kitchenMain, "food_safety_check", diaryId);
  assert.ok(
    photoGetRequests.some(get => get.entityType === "food_safety_check" && get.entityId === String(diaryId)),
    "KitchenTrack should reload the persisted photo using the existing diary record id",
  );

  await navigateHarness("bike");
  await page.getByRole("button", { name: "Hires", exact: true }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  const alphaRow = page.getByRole("row").filter({ hasText: bikeHires[0].guestName });
  const betaRow = page.getByRole("row").filter({ hasText: bikeHires[1].guestName });
  await alphaRow.waitFor({ state: "visible" });
  await betaRow.waitFor({ state: "visible" });
  assert.notEqual(bikeHires[0].id, bikeHires[1].id, "bike fixture hire rows must have distinct ids");
  assert.equal(
    new Set(bikeHires.flatMap(hire => [hire.id, hire.preCheckId, hire.postCheckId])).size,
    6,
    "bike hire and pre/post-check fixture ids must all be independent",
  );

  const bikeUploadTargets = [
    {
      row: alphaRow,
      input: alphaRow.getByText("Pre:", { exact: false }).locator("xpath=..").locator('input[type="file"]'),
      entityType: "bike_check",
      entityId: bikeHires[0].preCheckId,
      section: alphaRow.getByText("Pre:", { exact: false }).locator("xpath=.."),
    },
    {
      row: alphaRow,
      input: alphaRow.getByText("Post:", { exact: false }).locator("xpath=..").locator('input[type="file"]'),
      entityType: "bike_check",
      entityId: bikeHires[0].postCheckId,
      section: alphaRow.getByText("Post:", { exact: false }).locator("xpath=.."),
    },
    {
      row: alphaRow,
      input: alphaRow.locator("td").nth(6).locator('input[type="file"]'),
      entityType: "bike_hire",
      entityId: bikeHires[0].id,
      section: alphaRow.locator("td").nth(6),
    },
    {
      row: betaRow,
      input: betaRow.getByText("Pre:", { exact: false }).locator("xpath=..").locator('input[type="file"]'),
      entityType: "bike_check",
      entityId: bikeHires[1].preCheckId,
      section: betaRow.getByText("Pre:", { exact: false }).locator("xpath=.."),
    },
    {
      row: betaRow,
      input: betaRow.getByText("Post:", { exact: false }).locator("xpath=..").locator('input[type="file"]'),
      entityType: "bike_check",
      entityId: bikeHires[1].postCheckId,
      section: betaRow.getByText("Post:", { exact: false }).locator("xpath=.."),
    },
    {
      row: betaRow,
      input: betaRow.locator("td").nth(6).locator('input[type="file"]'),
      entityType: "bike_hire",
      entityId: bikeHires[1].id,
      section: betaRow.locator("td").nth(6),
    },
  ];

  for (const target of bikeUploadTargets) {
    assert.equal(await target.input.count(), 1, `${target.entityType} ${target.entityId} should have one real uploader input in its visible row section`);
    await uploadAndAssert(target.input, target.section, target.entityType, target.entityId);
    await target.row.getByText(target.row === alphaRow ? bikeHires[0].guestName : bikeHires[1].guestName, { exact: true }).waitFor({ state: "visible" });
  }

  for (const hire of bikeHires) {
    for (const [entityType, entityId] of [
      ["bike_hire", hire.id],
      ["bike_check", hire.preCheckId],
      ["bike_check", hire.postCheckId],
    ]) {
      assert.ok(
        photoGetRequests.some(get => get.entityType === entityType && get.entityId === String(entityId)),
        `BikeTrack should query persisted photos for ${entityType} ${entityId}`,
      );
      assert.ok(
        photoAssociationBodies.some(body => body.entityType === entityType && body.entityId === entityId),
        `BikeTrack should associate a photo to ${entityType} ${entityId}`,
      );
    }
  }

  assert.ok(csrfTokenRequests > 0, "the photo POSTs must obtain a shared CSRF token before upload");
  assert.ok(photoMutationHeaders.length > 0, "photo mutation requests must be observed");
  for (const { pathname, token } of photoMutationHeaders) {
    assert.equal(token, "photo-test-csrf", `${pathname} must carry the shared session CSRF header`);
  }
  assert.ok(storagePutHeaders.length > 0, "the upload flow must PUT bytes to fake object storage");
  assert.ok(storagePutHeaders.every(token => token === null), "object-storage PUTs must not receive the session CSRF header");
  assert.deepEqual(unexpectedApiRequests, [], `unexpected API requests must fail the browser test: ${JSON.stringify(unexpectedApiRequests)}`);
  assert.deepEqual(pageErrors, [], `the actual page components must not throw: ${pageErrors.join("; ")}`);

  console.log("SafeTrack, KitchenTrack and BikeTrack photo association browser checks passed.");
} catch (error) {
  console.error("Photo upload browser test failed:", error);
  if (page) {
    console.error("Photo upload browser page:", page.url());
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