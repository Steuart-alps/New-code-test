import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the manager-facing "Customise options" editor
// (src/components/form-options-editor.tsx). The API keeps disabled values so
// historical records stay valid; this checks the editor never loses them:
//   - a disabled custom value is still listed after the editor is reopened,
//   - Enable moves it back to the active list and the save persists that,
//   - disabled built-ins and custom values render apart from active rows,
//   - no more than 50 active options can be added, enabled or saved.
// The /api/form-options fixture is stateful and mirrors
// artifacts/api-server/src/routes/form-options.ts and src/lib/formOptions.ts.
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
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test" },
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
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(path => existsSync(path));

// ─── Stateful /api/form-options fixture ──────────────────────────────────────

const KEY = "fixtrack_trades";
const CLIENT_ID = 23;
const MAX_OPTIONS = 50;
// DEFAULT_FIXTRACK_TRADES in artifacts/api-server/src/lib/formOptions.ts.
const DEFAULT_TRADES = [
  "electrical", "plumbing",
  "gas_kitchen", "gas_fireplace", "gas_heating",
  "structural", "equipment", "hvac",
  "fire_alarm", "emergency_lighting", "fire_extinguishers",
  "kitchen_fire_suppression", "sprinkler_systems", "aov_smoke_vents",
  "dry_wet_risers", "fire_doors", "fire_shutters_curtains", "fire_dampers",
  "fire_stopping", "kitchen_extract_cleaning", "fire_risk_assessor",
  "intruder_alarm", "cctv", "access_control",
  "legionella_water_hygiene", "pest_control", "pat_testing", "loler_puwer_inspection",
  "lev_testing", "asbestos", "tree_surgeon_arborist", "pool_spa_maintenance", "waste_collection",
  "it_comms",
  "safety_hazard", "cleaning", "general",
];
const humanize = value => value.split("_").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
const lower = value => value.toLowerCase();

/** The saved app_settings state for the trades list, or null for "default". */
let stored = null;
const putBodies = [];
const rejectedPuts = [];
const unexpectedRequests = [];
const csrfMissing = [];
const wrongClient = [];

function validateOptionList(input) {
  if (!Array.isArray(input)) return { ok: false, error: "items must be an array" };
  if (input.length === 0) return { ok: false, error: "items must not be empty" };
  if (input.length > MAX_OPTIONS) return { ok: false, error: `too many items (max ${MAX_OPTIONS})` };
  const cleaned = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== "string") return { ok: false, error: "items must be strings" };
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "items must not be blank" };
    if (trimmed.length > 60) return { ok: false, error: "item too long (max 60 chars)" };
    if (seen.has(lower(trimmed))) return { ok: false, error: `duplicate item: ${trimmed}` };
    seen.add(lower(trimmed));
    cleaned.push(trimmed);
  }
  return { ok: true, value: cleaned };
}

function formOptionsResponse() {
  const active = stored?.active ?? [...DEFAULT_TRADES];
  const disabled = (stored?.disabled ?? []).filter(item => !active.some(a => lower(a) === lower(item)));
  return {
    options: { [KEY]: active },
    defaults: { [KEY]: [...DEFAULT_TRADES] },
    disabled: { [KEY]: disabled },
    customised: { [KEY]: stored !== null },
  };
}

function savePut(items) {
  const check = validateOptionList(items);
  if (!check.ok) return check;
  const current = stored ?? { active: [...DEFAULT_TRADES], disabled: [] };
  const activeKeys = new Set(check.value.map(lower));
  const disabled = [
    ...current.disabled,
    ...current.active.filter(item => !activeKeys.has(lower(item))),
  ].filter((item, index, all) =>
    !activeKeys.has(lower(item)) && all.findIndex(candidate => lower(candidate) === lower(item)) === index,
  );
  stored = { active: check.value, disabled };
  return { ok: true, value: check.value };
}

const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
async function routeApi(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  const path = url.pathname;
  if (path.startsWith("/api/form-options")) {
    if (url.searchParams.get("clientId") !== String(CLIENT_ID)) wrongClient.push(`${method} ${url.pathname}${url.search}`);
  }
  if (method === "GET") {
    switch (path) {
      case "/api/auth/csrf-token": return json(route, { token: "form-options-csrf" });
      case "/api/auth/me": return json(route, {
        user: { id: 7, email: "manager@example.test", name: "Site Manager", role: "client_admin", clientId: CLIENT_ID, departmentId: null, active: true, totpEnabled: true },
        billingLocked: false, client: { id: CLIENT_ID, name: "Harbour Hotel Group", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
        services: ["fixtrack"],
      });
      case "/api/billing/cancellation-status": return json(route, { accessEndsAt: null });
      case "/api/managed-by": return json(route, null);
      // Setup is finished, so the "Add your team first" gate stays out of the way.
      case "/api/setup/state": return json(route, { needsSetup: false, canManage: true, team: { recorders: 2, aloneAt: null, ready: true } });
      case "/api/form-options": return json(route, formOptionsResponse());
    }
  }
  if (path === `/api/form-options/${KEY}` && (method === "PUT" || method === "DELETE")) {
    if (request.headers()["x-csrf-token"] !== "form-options-csrf") csrfMissing.push(`${method} ${path}`);
    if (method === "DELETE") {
      stored = null;
      return json(route, { ok: true, items: [...DEFAULT_TRADES] });
    }
    const body = JSON.parse(request.postData() ?? "{}");
    putBodies.push(body);
    const result = savePut(body.items);
    if (!result.ok) {
      rejectedPuts.push(result.error);
      return json(route, { error: result.error }, 400);
    }
    return json(route, { ok: true, items: result.value });
  }
  if (method === "POST" && path === "/api/analytics/events") return route.fulfill({ status: 204 });
  unexpectedRequests.push(`${method} ${path}`);
  return json(route, { error: "Not in the form options fixture" }, 404);
}

// Records every toast the page shows (they render outside the modal dialog).
function captureToasts() {
  window.__toasts = [];
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const toast of document.querySelectorAll("[role='region'] ol > li")) {
      if (seen.has(toast)) continue;
      seen.add(toast);
      window.__toasts.push(toast.textContent.replace(/\s+/g, " ").trim());
    }
  }).observe(document, { childList: true, subtree: true });
}

// ─── Page helpers ────────────────────────────────────────────────────────────

const dialogOf = page => page.getByRole("dialog", { name: "Contractor trades" });

async function loadPage(page) {
  await page.goto(`${baseUrl}/tests/form-options-editor-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Customise trades" }).waitFor();
}

async function openEditor(page, expectedActiveCount) {
  await page.getByRole("button", { name: "Customise trades" }).click();
  const dialog = dialogOf(page);
  await dialog.waitFor();
  // Wait until the editor has copied the server list into its rows.
  await page.waitForFunction(count =>
    document.querySelectorAll("[role='dialog'] input[aria-label^='Rename ']").length === count, expectedActiveCount);
  return dialog;
}

async function closeEditor(page) {
  await dialogOf(page).getByRole("button", { name: "Cancel" }).click();
  await dialogOf(page).waitFor({ state: "detached" });
}

async function save(page) {
  const before = putBodies.length;
  const toastsBefore = await toastCount(page);
  await dialogOf(page).getByRole("button", { name: "Save" }).click();
  await dialogOf(page).waitFor({ state: "detached" });
  await expectToast(page, toastsBefore, "Options saved");
  assert.equal(putBodies.length, before + 1, "Save sends exactly one PUT");
  return putBodies.at(-1);
}

/** What the open editor shows: active rows and the "Disabled options" section. */
async function editorState(page) {
  const state = await dialogOf(page).evaluate(dialog => {
    const style = el => {
      const cs = getComputedStyle(el);
      return { borderStyle: cs.borderTopStyle, color: cs.color };
    };
    const activeInputs = [...dialog.querySelectorAll("input[aria-label^='Rename ']")];
    const heading = [...dialog.querySelectorAll("p")].find(p => p.textContent.trim() === "Disabled options");
    const disabledRows = heading ? [...heading.parentElement.children].filter(el => el !== heading) : [];
    return {
      active: activeInputs.map(input => input.value),
      activeRows: activeInputs.map(input => {
        const row = input.parentElement;
        return {
          ...style(row),
          textColor: getComputedStyle(input).color,
          editable: !input.readOnly && !input.disabled,
          disableButton: row.querySelector("button[aria-label^='Disable ']")?.getAttribute("aria-label") ?? null,
        };
      }),
      disabled: disabledRows.map(row => ({
        label: row.querySelector("span")?.textContent.trim() ?? row.textContent.trim(),
        ...style(row),
        textColor: getComputedStyle(row.querySelector("span") ?? row).color,
        editableFields: row.querySelectorAll("input, textarea, select, [contenteditable='true']").length,
        buttons: [...row.querySelectorAll("button")].map(button => button.textContent.trim()),
      })),
      headingBeforeActive: heading ? activeInputs.some(input =>
        heading.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
    };
  });
  // Built-in options show their label; `active` is what each row stores.
  return { ...state, shown: state.active, active: state.active.map(storedValue) };
}

/** The stored value behind a row's text: a built-in shows its label. */
const storedValue = text => DEFAULT_TRADES.find(value => humanize(value) === text) ?? text;

const enableButton = (page, label) =>
  dialogOf(page).getByText(label, { exact: true }).locator("xpath=..").getByRole("button", { name: "Enable" });

async function expectToast(page, before, title, description) {
  await page.waitForFunction(count => window.__toasts.length > count, before);
  const toasts = await page.evaluate(() => window.__toasts);
  const latest = toasts.at(-1);
  assert.ok(latest.includes(title) && (!description || latest.includes(description)),
    `expected a "${title}" toast, got ${JSON.stringify(toasts.slice(before))}`);
}
const toastCount = page => page.evaluate(() => window.__toasts.length);

function assertDistinct(state, label) {
  assert.ok(state.disabled.length > 0, `${label}: the disabled section is shown`);
  assert.ok(!state.headingBeforeActive, `${label}: the disabled section sits below the active list`);
  for (const row of state.activeRows) {
    assert.ok(row.editable, `${label}: active rows are editable inputs`);
    assert.ok(row.disableButton, `${label}: active rows offer Disable`);
    assert.notEqual(row.borderStyle, "dashed", `${label}: active rows have a solid border`);
  }
  for (const row of state.disabled) {
    assert.equal(row.editableFields, 0, `${label}: disabled "${row.label}" is not an editable field`);
    assert.deepEqual(row.buttons, ["Enable"], `${label}: disabled "${row.label}" only offers Enable`);
    assert.equal(row.borderStyle, "dashed", `${label}: disabled "${row.label}" has a dashed border`);
    assert.notEqual(row.textColor, state.activeRows[0].textColor, `${label}: disabled "${row.label}" is muted`);
  }
}

const sorted = list => [...list].sort();

// ─── Run ─────────────────────────────────────────────────────────────────────

const checks = [];
try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "en-GB" });
  await context.addInitScript(captureToasts);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", routeApi);

  // 1. The default list loads with nothing disabled.
  await loadPage(page);
  await openEditor(page, DEFAULT_TRADES.length);
  let state = await editorState(page);
  assert.deepEqual(state.active, DEFAULT_TRADES, "the editor starts from the default list");
  assert.deepEqual(state.shown, DEFAULT_TRADES.map(humanize), "built-in options show their capitalised label, not the stored code");
  assert.deepEqual(state.disabled, [], "no disabled section for an untouched list");

  // 2. Add a custom trade and disable a built-in; both persist.
  await dialogOf(page).getByPlaceholder("Add an option…").fill("Roof Access Crew");
  await dialogOf(page).getByRole("button", { name: "Add" }).click();
  await dialogOf(page).getByRole("button", { name: "Disable Gas Fireplace" }).click();
  state = await editorState(page);
  assert.deepEqual(state.disabled.map(row => row.label), ["Gas Fireplace"], "a disabled built-in moves to the disabled section before saving");
  let body = await save(page);
  assert.deepEqual(body.items, [...DEFAULT_TRADES.filter(t => t !== "gas_fireplace"), "Roof Access Crew"]);
  assert.deepEqual(stored.disabled, ["gas_fireplace"]);
  checks.push("custom value added and built-in disabled");

  // 3. Disable the custom trade; it is kept by the server…
  await openEditor(page, DEFAULT_TRADES.length);
  await dialogOf(page).getByRole("button", { name: "Disable Roof Access Crew" }).click();
  body = await save(page);
  assert.ok(!body.items.includes("Roof Access Crew"), "the disabled custom value is not sent as active");
  assert.deepEqual(sorted(stored.disabled), sorted(["gas_fireplace", "Roof Access Crew"]));

  // …and still listed as disabled when the editor is reopened, both in the
  // same session and after a full reload (fresh query cache).
  for (const when of ["reopened", "reloaded"]) {
    if (when === "reloaded") await loadPage(page);
    await openEditor(page, DEFAULT_TRADES.length - 1);
    state = await editorState(page);
    assert.ok(!state.active.includes("Roof Access Crew"), `${when}: disabled custom value is not active`);
    assert.ok(!state.active.includes("gas_fireplace"), `${when}: disabled built-in is not active`);
    assert.deepEqual(sorted(state.disabled.map(row => row.label)), sorted(["Gas Fireplace", "Roof Access Crew"]),
      `${when}: disabled built-in and custom values stay listed`);
    // 4. Disabled rows render apart from active rows.
    assertDistinct(state, when);
    assert.equal(await dialogOf(page).getByRole("textbox", { name: "Rename Roof Access Crew" }).count(), 0);
    assert.equal(await dialogOf(page).getByRole("button", { name: "Disable Roof Access Crew" }).count(), 0);
    await closeEditor(page);
  }
  checks.push("disabled custom value survives reopen and reload");
  checks.push("disabled built-in and custom rows render distinctly");

  // 5. Enabling and then cancelling changes nothing.
  await openEditor(page, DEFAULT_TRADES.length - 1);
  await enableButton(page, "Roof Access Crew").click();
  state = await editorState(page);
  assert.equal(state.active.at(-1), "Roof Access Crew", "Enable moves the value back to the active list");
  assert.deepEqual(state.disabled.map(row => row.label), ["Gas Fireplace"]);
  const putsBeforeCancel = putBodies.length;
  await closeEditor(page);
  assert.equal(putBodies.length, putsBeforeCancel, "Cancel sends nothing");
  await openEditor(page, DEFAULT_TRADES.length - 1);
  state = await editorState(page);
  assert.deepEqual(sorted(state.disabled.map(row => row.label)), sorted(["Gas Fireplace", "Roof Access Crew"]),
    "a cancelled Enable is discarded on reopen");

  // 6. Enable and save: the value is active again after reopen and reload.
  await enableButton(page, "Roof Access Crew").click();
  body = await save(page);
  assert.ok(body.items.includes("Roof Access Crew"), "the PUT sends the re-enabled value as active");
  assert.deepEqual(stored.disabled, ["gas_fireplace"], "the server no longer lists it as disabled");
  for (const when of ["reopened", "reloaded"]) {
    if (when === "reloaded") await loadPage(page);
    await openEditor(page, DEFAULT_TRADES.length);
    state = await editorState(page);
    assert.ok(state.active.includes("Roof Access Crew"), `${when}: re-enabled value is active`);
    assert.deepEqual(state.disabled.map(row => row.label), ["Gas Fireplace"], `${when}: only the built-in stays disabled`);
    await closeEditor(page);
  }
  checks.push("Enable restores a value and the save persists it");

  // 7. Typing a disabled value back in restores it rather than listing it twice.
  await openEditor(page, DEFAULT_TRADES.length);
  await dialogOf(page).getByPlaceholder("Add an option…").fill("GAS_FIREPLACE");
  await dialogOf(page).getByRole("button", { name: "Add" }).click();
  state = await editorState(page);
  assert.equal(state.active.filter(item => lower(item) === "gas_fireplace").length, 1, "the typed value is active once");
  assert.deepEqual(state.disabled, [], "the typed value leaves the disabled section");
  body = await save(page);
  assert.ok(body.items.includes("gas_fireplace"), "the restored built-in keeps its stored spelling");
  assert.deepEqual(stored.disabled, []);
  checks.push("re-adding a disabled value by name restores it");

  // 8. The 50-option limit applies to the active list.
  const customs = Array.from({ length: MAX_OPTIONS - DEFAULT_TRADES.length }, (_, i) => `Custom trade ${String(i + 1).padStart(2, "0")}`);
  stored = {
    active: [...DEFAULT_TRADES.filter(t => t !== "gas_fireplace"), ...customs], // 49
    disabled: ["gas_fireplace", "Roof Access Crew"],
  };
  assert.equal(stored.active.length, MAX_OPTIONS - 1);
  await loadPage(page);
  await openEditor(page, MAX_OPTIONS - 1);
  await enableButton(page, "Roof Access Crew").click();
  state = await editorState(page);
  assert.equal(state.active.length, MAX_OPTIONS, "enabling up to the limit is allowed");

  let before = await toastCount(page);
  await enableButton(page, "Gas Fireplace").click();
  await expectToast(page, before, "Too many items", "Max 50 options");
  state = await editorState(page);
  assert.equal(state.active.length, MAX_OPTIONS, "Enable beyond the limit is refused");
  assert.deepEqual(state.disabled.map(row => row.label), ["Gas Fireplace"], "the refused value stays disabled");

  before = await toastCount(page);
  await dialogOf(page).getByPlaceholder("Add an option…").fill("Overflow Trade");
  await dialogOf(page).getByRole("button", { name: "Add" }).click();
  await expectToast(page, before, "Too many items", "Max 50 options");
  before = await toastCount(page);
  await dialogOf(page).getByPlaceholder("Add an option…").press("Enter");
  await expectToast(page, before, "Too many items", "Max 50 options");
  state = await editorState(page);
  assert.equal(state.active.length, MAX_OPTIONS, "Add beyond the limit is refused");
  assert.ok(!state.active.includes("Overflow Trade"));

  body = await save(page);
  assert.equal(body.items.length, MAX_OPTIONS, "the save carries exactly the 50 active options");
  assert.ok(body.items.includes("Roof Access Crew") && !body.items.includes("gas_fireplace"));

  // Disabling one frees a slot, so the disabled built-in can be enabled again.
  await openEditor(page, MAX_OPTIONS);
  state = await editorState(page);
  assert.deepEqual(state.disabled.map(row => row.label), ["Gas Fireplace"]);
  await dialogOf(page).getByRole("button", { name: "Disable Custom trade 05" }).click();
  await enableButton(page, "Gas Fireplace").click();
  state = await editorState(page);
  assert.equal(state.active.length, MAX_OPTIONS);
  assert.deepEqual(state.disabled.map(row => row.label), ["Custom trade 05"]);
  body = await save(page);
  assert.equal(body.items.length, MAX_OPTIONS);
  assert.ok(body.items.includes("gas_fireplace") && !body.items.includes("Custom trade 05"));
  assert.deepEqual(stored.disabled, ["Custom trade 05"], "the server keeps the newly disabled custom value");
  checks.push("the 50 active option limit holds for Add, Enter, Enable and Save");

  assert.ok(putBodies.every(put => Array.isArray(put.items) && put.items.length <= MAX_OPTIONS),
    "no PUT ever carries more than 50 options");
  assert.deepEqual(rejectedPuts, [], "every save was accepted by the API rules");
  assert.deepEqual(csrfMissing, [], "every write carries the CSRF token");
  assert.deepEqual(wrongClient, [], "every form-options request is scoped to the active client");
  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`Form options editor browser checks passed (${checks.length}/${checks.length}):\n${checks.map(c => `  ✓ ${c}`).join("\n")}`);
} catch (error) {
  console.error("Form options editor page:", browser ? await browser.contexts()[0]?.pages()[0]?.locator("body").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
