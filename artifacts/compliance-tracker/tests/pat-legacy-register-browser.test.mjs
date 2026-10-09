import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Screen-level regressions for the legacy PAT appliance register: retirement
// with retained tests, archived history, reactivation, new-test targets,
// correction controls and recorded vs migrated location messaging. API
// responses mirror artifacts/api-server/src/routes/pat-track.ts.
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const freePort = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
};
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test", REPL_ID: undefined },
  stdio: ["ignore", "ignore", "pipe"],
});
let viteError = "";
vite.stderr.on("data", chunk => { viteError += chunk.toString(); });
let browser;

async function waitForVite() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}
const chromiumPath = () => process.env.CHROMIUM_PATH
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/repl/tools/bin/chromium"].find(path => existsSync(path));

const today = new Date().toISOString().slice(0, 10);
const appliance = (id, name, overrides = {}) => ({
  id, client_id: 23, site_id: 4, name, appliance_type: "Kitchen Appliance", location: "Kitchen", asset_tag: `TAG-${id}`,
  description: null, active: true, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  last_test_date: null, last_result: null, next_test_date: null, last_tested_by: null,
  last_test_site_id: null, last_test_site_name: null, last_test_location: null, last_test_location_source: null, ...overrides,
});
const test = (id, applianceId, name, overrides = {}) => ({
  id, client_id: 23, appliance_id: applianceId, site_id_snapshot: 4, site_name_snapshot: "Harbour Hotel",
  department_id_snapshot: null, location_snapshot: "Kitchen", appliance_name_snapshot: name, appliance_type_snapshot: "Class I",
  asset_tag_snapshot: `TAG-${applianceId}`, snapshot_source: "recorded", test_date: "2026-03-01", result: "pass",
  next_test_date: "2027-03-01", tested_by: "A Tester", visual_inspection: "pass", earth_continuity_ohms: "0.1",
  insulation_mohms: ">200", operating_current: null, notes: null, created_by: 1, created_at: "2026-03-01T10:00:00.000Z",
  updated_at: "2026-03-01T10:00:00.000Z", appliance_name: name, appliance_type: "Class I", asset_tag: `TAG-${applianceId}`, ...overrides,
});

const state = {
  appliances: [
    appliance(11, "Active kettle", { last_test_date: "2026-03-01", last_result: "pass", next_test_date: "2027-03-01", last_tested_by: "A Tester" }),
    appliance(12, "Retired heater", { active: false, location: "Moved store" }),
  ],
  tests: [
    test(101, 11, "Active kettle"),
    test(102, 12, "Retired heater (as tested)", { snapshot_source: "legacy_backfill", location_snapshot: "Old boiler room", site_name_snapshot: "Old site" }),
    test(103, 12, "Retired heater (as tested)", { snapshot_source: "legacy_unavailable", site_id_snapshot: null, site_name_snapshot: null, location_snapshot: null, test_date: "2025-03-01" }),
  ],
};
const requests = [];
const counts = () => Object.fromEntries(["/api/pat-track/appliances", "/api/pat-track/tests", "/api/pat-track/status"]
  .map(path => [path, requests.filter(r => r.method === "GET" && r.path === path).length]));
const status = () => {
  const active = state.appliances.filter(a => a.active);
  return { totalAppliances: active.length, untested: active.filter(a => !a.next_test_date).length, overdue: 0, dueSoon: 0, ok: active.filter(a => a.next_test_date).length };
};
const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    requests.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/auth/csrf-token") return json(route, { token: "browser-test-csrf" });
    if (url.pathname === "/api/auth/me") return json(route, {
      user: { id: 5, email: "pat-admin@example.test", name: "PAT Admin", role: "client_admin", clientId: 23, departmentId: null, active: true, totpEnabled: true },
      billingLocked: false, client: { id: 23, name: "PAT Test Client", slug: "pat-test", logoUrl: null, primaryColor: "#2F7C8C", active: true },
      services: ["pattrack"],
    });
    if (url.pathname === "/api/sites") return json(route, [{ id: 4, name: "Harbour Hotel" }]);
    if (url.pathname === "/api/photos") return json(route, []);
    if (url.pathname === "/api/pat-track/config") return json(route, { pat_default_tester: "", pat_retest_months: "12", pat_locations: "[]", pat_show_earth_bond: "true", pat_show_insulation: "true" });
    if (url.pathname === "/api/pat-track/status") return json(route, status());
    if (url.pathname === "/api/pat-track/appliances" && method === "GET") return json(route, state.appliances);
    if (url.pathname === "/api/pat-track/tests" && method === "GET") return json(route, state.tests);
    const applianceMatch = url.pathname.match(/^\/api\/pat-track\/appliances\/(\d+)$/);
    if (applianceMatch && method === "DELETE") {
      const target = state.appliances.find(a => a.id === Number(applianceMatch[1]));
      target.active = false;
      return json(route, { ok: true, archived: true, message: "Appliance retired; test history retained." });
    }
    if (applianceMatch && method === "PUT") {
      const target = state.appliances.find(a => a.id === Number(applianceMatch[1]));
      Object.assign(target, { name: body.name, location: body.location, active: body.active ?? true });
      return json(route, { ...target, siteId: target.site_id });
    }
    const testMatch = url.pathname.match(/^\/api\/pat-track\/tests\/(\d+)$/);
    if (testMatch && method === "PUT") {
      const target = state.tests.find(t => t.id === Number(testMatch[1]));
      if (body.applianceId !== target.appliance_id) return json(route, { error: "Historical PAT tests cannot be reassigned to another appliance" }, 409);
      Object.assign(target, { notes: body.notes, result: body.result });
      return json(route, { id: target.id, applianceId: target.appliance_id, notes: body.notes, snapshotSource: target.snapshot_source });
    }
    if (testMatch && method === "DELETE") return json(route, { error: "PAT tests are retained as compliance evidence and cannot be deleted" }, 405);
    throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
  });

  await page.goto(`${baseUrl}/tests/pat-legacy-register-harness.html`, { waitUntil: "domcontentloaded" });
  const activeRow = page.getByTestId("row-legacy-appliance-11"), retiredRow = page.getByTestId("row-legacy-appliance-12");
  await activeRow.waitFor();

  // Archived appliances stay visible but cannot be targeted or re-retired.
  assert.ok(await retiredRow.getByText("Retired", { exact: true }).isVisible(), "retired appliance is labelled in the archive");
  assert.equal(await page.getByTestId("button-test-legacy-appliance-12").count(), 0, "retired appliance has no log-test shortcut");
  assert.ok(await page.getByTestId("button-retire-legacy-appliance-12").isDisabled(), "a retired appliance cannot be retired again");
  assert.equal(await activeRow.getByText("Retired", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("button-test-legacy-appliance-11").count(), 1);

  // New-test targets exclude retired assets.
  await page.getByTestId("button-add-legacy-test").click();
  const newTargets = await page.getByTestId("select-legacy-test-appliance").locator("option").allTextContents();
  assert.deepEqual(newTargets, ["Select appliance", "Active kettle (TAG-11)"], "only active appliances are offered for new tests");
  await page.getByTestId("button-cancel-legacy-test").click();

  // Retirement confirmation accurately describes what happens to the history.
  await page.getByTestId("button-retire-legacy-appliance-11").click();
  const confirmation = await page.getByRole("alertdialog").innerText();
  assert.match(confirmation, /Retire this appliance\?/);
  assert.match(confirmation, /removes the appliance from active test targets/);
  assert.match(confirmation, /Existing PAT tests and snapshot evidence remain available in history/);
  assert.match(confirmation, /reactivate the appliance/);
  assert.doesNotMatch(confirmation, /delete|permanently|cannot be undone/i, "retirement must not be described as deletion");
  const beforeRetire = counts();
  await page.getByTestId("button-confirm-retire-legacy-appliance").click();
  await activeRow.getByText("Retired", { exact: true }).waitFor();
  assert.ok(requests.some(r => r.method === "DELETE" && r.path === "/api/pat-track/appliances/11"));
  await page.getByText("The appliance and its PAT test history are retained in the archive.", { exact: true }).first().waitFor();
  const afterRetire = counts();
  for (const path of Object.keys(beforeRetire)) {
    assert.ok(afterRetire[path] > beforeRetire[path], `retirement refreshes ${path}`);
  }
  assert.equal(await page.getByTestId("button-test-legacy-appliance-11").count(), 0, "a newly retired appliance leaves the test targets");
  await page.getByTestId("button-add-legacy-test").click();
  assert.deepEqual(await page.getByTestId("select-legacy-test-appliance").locator("option").allTextContents(), ["Select appliance"]);
  await page.getByTestId("button-cancel-legacy-test").click();

  // Reactivation goes through Edit appliance and refreshes the same lists.
  await page.getByTestId("button-edit-legacy-appliance-11").click();
  const activeSwitch = page.getByTestId("switch-legacy-appliance-active");
  assert.equal(await activeSwitch.getAttribute("aria-checked"), "false");
  await activeSwitch.click();
  const beforeReactivate = counts();
  await page.getByTestId("button-save-legacy-appliance").click();
  await page.getByTestId("button-test-legacy-appliance-11").waitFor();
  const reactivation = requests.filter(r => r.method === "PUT" && r.path === "/api/pat-track/appliances/11").at(-1);
  assert.equal(reactivation?.body?.active, true, "reactivation sends active: true");
  const afterReactivate = counts();
  for (const path of Object.keys(beforeReactivate)) {
    assert.ok(afterReactivate[path] > beforeReactivate[path], `reactivation refreshes ${path}`);
  }
  assert.equal(await activeRow.getByText("Retired", { exact: true }).count(), 0);

  // History keeps tests of retired appliances, with honest location provenance.
  await page.getByTestId("harness-view-tests").click();
  const recordedRow = page.getByTestId("row-legacy-test-101");
  await recordedRow.waitFor();
  assert.match(await recordedRow.innerText(), /Recorded at test: Harbour Hotel · Kitchen/);
  const backfilledRow = page.getByTestId("row-legacy-test-102");
  assert.match(await backfilledRow.innerText(), /Retired heater \(as tested\)/, "retired appliance history remains visible");
  assert.match(await backfilledRow.innerText(), /Legacy backfill \(not verified at test date\): Old site · Old boiler room/);
  assert.doesNotMatch(await backfilledRow.innerText(), /Recorded at test/);
  assert.match(await page.getByTestId("row-legacy-test-103").innerText(), /Historic site \/ location unavailable/);
  assert.doesNotMatch(await page.getByTestId("row-legacy-test-103").innerText(), /Moved store/, "the live appliance location is never shown as history");

  // Retained tests have no delete control.
  const testTable = page.getByTestId("panel-legacy-tests");
  assert.equal(await testTable.locator('[data-testid^="button-delete"]').count(), 0);
  assert.equal(await testTable.getByRole("button", { name: /delete|remove/i }).count(), 0);

  // Correcting a retired appliance's test keeps the appliance fixed.
  await page.getByTestId("button-edit-legacy-test-102").click();
  const fixedSelect = page.getByTestId("select-legacy-test-appliance");
  assert.ok(await fixedSelect.isDisabled(), "appliance selection is locked during corrections");
  assert.equal(await fixedSelect.inputValue(), "12");
  assert.match(await fixedSelect.locator("option:checked").innerText(), /Retired heater \(TAG-12\) \(Retired\)/);
  assert.ok(await page.getByText("This retained test record cannot be reassigned to another appliance.").isVisible());
  await page.getByTestId("textarea-legacy-test-notes").fill("Correction from original sheet");
  const beforeCorrection = counts();
  await page.getByTestId("button-save-legacy-test").click();
  await page.getByText("Test record updated").first().waitFor();
  const correction = requests.filter(r => r.method === "PUT" && r.path === "/api/pat-track/tests/102").at(-1);
  assert.equal(correction?.body?.applianceId, 12, "correction is saved against the original appliance");
  assert.equal(correction?.body?.notes, "Correction from original sheet");
  const afterCorrection = counts();
  assert.ok(afterCorrection["/api/pat-track/tests"] > beforeCorrection["/api/pat-track/tests"], "correction refreshes the test history");
  assert.equal(requests.filter(r => r.method === "DELETE" && r.path.startsWith("/api/pat-track/tests/")).length, 0);
  assert.deepEqual(pageErrors, []);
  console.log("Legacy PAT register browser checks passed: retirement, archive, reactivation, new-test targets, corrections, no test deletion and location provenance.");
} catch (error) {
  console.error("Legacy PAT register page:", browser ? await browser.contexts()[0]?.pages()[0]?.locator("body").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
