// SafeTrack induction: form → API → reload → print, against the real API and
// a disposable production-style database. Distinct from induction-print.test.mjs,
// which only renders HTML from a record built in the test.
//
// The app's /safe-track route redirects to DocTrack, so the SafeTrack page is
// mounted directly by tests/safe-track-induction-harness.tsx.
//
// Run: pnpm --filter @workspace/api-server run test:safe-track-induction-browser
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { base as apiBase, createTenant } from "../../api-server/tests/approval-workflow-fixtures.mjs";

if (process.env.FRESH_SCHEMA_BROWSER_POLICY !== "1") {
  throw new Error("Run through `pnpm --filter @workspace/api-server run test:safe-track-induction-browser`.");
}

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const apiOrigin = new URL(apiBase).origin;
const SECTIONS = [
  "Accident & Hazard Reporting", "Asbestos Log", "COSHH", "Communication & Consultation on H&S",
  "Display Screen Equipment (DSE)", "Fire & Emergency Procedures", "First Aid Provision",
  "Health & Safety Policy Statement", "Housekeeping — Fire Safety", "Housekeeping — Electrical Safety",
  "Housekeeping — General Workplace Safety", "Infection Control", "Manual Handling", "Vehicle Movement",
  "Falls from Height", "Work Equipment", "Working at Height", "Lone Working / Personal Safety", "Medicines",
  "Mobile Phone Use", "Personal Protective Equipment (PPE)", "Risk Assessments", "Wellbeing", "Workplace Facilities",
];
const STATUS_BUTTON = { yes: "Yes", no: "No", na: "N/A" };
const PRINTED_STATUS = { yes: "Yes", no: "No", na: "N/A", "": "Not recorded" };
// Every topic answered, cycling Yes / No / N/A, each with its own comment
// (including characters the printout must escape).
const answers = SECTIONS.map((label, index) => ({
  status: ["yes", "no", "na"][index % 3],
  comments: `Topic ${index + 1}: covered with <b>${label}</b> & "notes"`,
}));
// Dates sit inside the one-day correction window on the account's calendar
// (Europe/London by default): older dates need an owner's reason, which the
// app's reason prompt supplies and this page-only harness does not mount.
const londonDay = offsetDays => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
  .format(new Date(Date.now() + offsetDays * 86_400_000));
const today = londonDay(0);
const yesterday = londonDay(-1);
const record = {
  staffName: "Jamie O'Neill",
  jobTitle: "Chef de partie",
  department: "Kitchen & Bar",
  startDate: yesterday,
  completedAt: yesterday,
  notes: "Signed off by the head chef; refresher booked <in 6 months>.",
};

let vite, viteCacheDir, browser, appOrigin, owner, page;

async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

before(async () => {
  const port = await freePort();
  appOrigin = `http://127.0.0.1:${port}`;
  process.env.PORT = String(port);
  process.env.BASE_PATH = "/";
  viteCacheDir = await mkdtemp(path.join(tmpdir(), "safe-track-induction-vite-"));
  vite = await createViteServer({
    configFile: path.join(appRoot, "vite.config.ts"), configLoader: "runner", cacheDir: viteCacheDir,
    logLevel: "error", server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  });
  await vite.listen();
  const executablePath = process.env.CHROMIUM_PATH
    ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(candidate => existsSync(candidate));
  browser = await chromium.launch({ headless: true, executablePath });

  owner = await createTenant("induction-owner", { browserPolicy: true });
  // An established business: with setup unfinished and no team, record pages
  // show "Add your team first" instead of the form.
  assert.equal((await owner.request("POST", "/setup/team-alone", {})).status, 200);
  assert.equal((await owner.request("POST", "/setup/complete", {})).status, 200);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "en-GB" });
  // One origin for the browser, as in production; the proxy only rewrites the
  // app origin to the API's so the real CSRF same-origin check still applies.
  await context.route(`${appOrigin}/api/**`, async route => {
    const original = new URL(route.request().url());
    const headers = { ...route.request().headers() };
    if (headers.origin === appOrigin) headers.origin = apiOrigin;
    await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${original.pathname}${original.search}`, headers }) });
  });
  const cookie = owner.request.cookie();
  const separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: appOrigin }]);
  page = await context.newPage();
  // Capture what Print hands the browser's print dialog.
  await context.addInitScript(() => {
    window.__printed = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (blob?.type === "text/html") blob.text().then(text => window.__printed.push(text));
      return createObjectURL(blob);
    };
  });
});

after(async () => {
  await browser?.close();
  await vite?.close();
  if (viteCacheDir) await rm(viteCacheDir, { recursive: true, force: true });
});

const dialog = () => page.getByRole("dialog");
const inductionRow = () => page.locator("tr", { hasText: record.staffName });

async function openInductions() {
  await page.goto(`${appOrigin}/tests/safe-track-induction-harness.html`);
  await page.getByRole("tab", { name: "Inductions" }).click();
  await page.getByText(/No inductions yet|Jamie O'Neill/).first().waitFor({ timeout: 60_000 });
}

function fieldInput(label) {
  return dialog().locator("label", { hasText: new RegExp(`^${label}`) }).locator("xpath=..").locator("input, textarea").first();
}

async function sections() {
  return dialog().locator(".divide-y > div").all();
}

/** What the open form shows: header fields and each topic's selected status and comment. */
async function formContents() {
  const topics = [];
  for (const section of await sections()) {
    const selected = await section.locator("button").evaluateAll(buttons =>
      buttons.filter(b => b.className.includes("bg-primary")).map(b => b.textContent));
    topics.push({
      label: (await section.locator("span").first().innerText()).replace(/^\d+\.\s*/, ""),
      status: { Yes: "yes", No: "no", "N/A": "na" }[selected[0]] ?? "",
      comments: await section.locator("input").inputValue(),
    });
  }
  return {
    staffName: await dialog().getByPlaceholder("Full name").inputValue(),
    jobTitle: await fieldInput("Job Title").inputValue(),
    department: await fieldInput("Department").inputValue(),
    startDate: await fieldInput("Start Date").inputValue(),
    completedAt: await fieldInput("Completed Date").inputValue(),
    notes: await fieldInput("Notes / Sign-off Comments").inputValue(),
    topics,
  };
}

async function storedInduction() {
  const { data } = await owner.request("GET", "/safe-track/inductions");
  const row = data.find(item => item.staffName === record.staffName);
  return { ...row, checklist: JSON.parse(row.checklist) };
}

test("every topic, comment and sign-off field saves, reloads and prints", async () => {
  await openInductions();
  await page.getByRole("button", { name: "Add Record" }).click();
  await dialog().getByPlaceholder("Full name").fill(record.staffName);
  await fieldInput("Job Title").fill(record.jobTitle);
  await fieldInput("Department").fill(record.department);
  await fieldInput("Start Date").fill(record.startDate);
  await fieldInput("Completed Date").fill(record.completedAt);
  const rows = await sections();
  assert.equal(rows.length, SECTIONS.length, "the form offers all 24 topics");
  for (const [index, section] of rows.entries()) {
    await section.getByRole("button", { name: STATUS_BUTTON[answers[index].status], exact: true }).click();
    await section.locator("input").fill(answers[index].comments);
  }
  await fieldInput("Notes / Sign-off Comments").fill(record.notes);
  await dialog().getByRole("button", { name: "Create" }).click();
  await dialog().waitFor({ state: "detached" });
  await inductionRow().waitFor();
  assert.match(await inductionRow().innerText(), /24\/24/, "the list shows every topic answered");

  const stored = await storedInduction();
  assert.equal(stored.staffName, record.staffName);
  assert.equal(stored.startDate, record.startDate);
  assert.equal(stored.completedAt, record.completedAt);
  assert.equal(stored.notes, record.notes);
  assert.equal(stored.checklist.jobTitle, record.jobTitle);
  assert.equal(stored.checklist.department, record.department);
  assert.deepEqual(stored.checklist.items.map(({ status, comments }) => ({ status, comments })), answers);

  // A fresh page load, then reopen the saved record before printing.
  await openInductions();
  await inductionRow().getByRole("button", { name: "Edit" }).click();
  await dialog().getByPlaceholder("Full name").waitFor();
  const reopened = await formContents();
  assert.deepEqual(reopened, {
    ...record,
    topics: SECTIONS.map((label, index) => ({ label, ...answers[index] })),
  });

  // Edit two topics and the sign-off, save, reload and reopen again.
  answers[2] = { status: "yes", comments: "COSHH sheets read and signed" };
  answers[23] = { status: "", comments: "" };
  record.completedAt = today;
  const edited = await sections();
  await edited[2].getByRole("button", { name: "Yes", exact: true }).click();
  await edited[2].locator("input").fill(answers[2].comments);
  await edited[23].getByRole("button", { name: "Yes", exact: true }).click(); // was N/A, cycle off
  await edited[23].getByRole("button", { name: "Yes", exact: true }).click();
  await edited[23].locator("input").fill("");
  await fieldInput("Completed Date").fill(record.completedAt);
  await dialog().getByRole("button", { name: "Save Changes" }).click();
  await dialog().waitFor({ state: "detached" });
  await openInductions();
  await inductionRow().getByRole("button", { name: "Edit" }).click();
  await dialog().getByPlaceholder("Full name").waitFor();
  assert.deepEqual(await formContents(), {
    ...record,
    topics: SECTIONS.map((label, index) => ({ label, ...answers[index] })),
  });
  await dialog().getByRole("button", { name: "Cancel" }).click();

  // Print the reloaded record.
  await inductionRow().getByRole("button", { name: /Print/ }).click();
  const html = await page.waitForFunction(() => window.__printed.at(-1)).then(handle => handle.jsonValue());
  const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  for (const [label, value] of [["Employee name", record.staffName], ["Job title", record.jobTitle],
    ["Department", record.department], ["Start date", record.startDate], ["Induction completed", record.completedAt]]) {
    assert.ok(html.includes(`<span class="label">${label}</span><span class="value">${escape(value)}</span>`), `${label} printed`);
  }
  assert.ok(html.includes(escape(record.notes)), "sign-off notes printed");
  const printedRows = [...html.matchAll(/<tr><td class="number">(\d+)<\/td><td>(.*?)<\/td><td class="status [^"]*">(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)];
  assert.deepEqual(printedRows.map(([, number, label, status, comments]) => [number, label, status, comments]),
    SECTIONS.map((label, index) => [String(index + 1), escape(label), PRINTED_STATUS[answers[index].status], escape(answers[index].comments || "—")]));
  assert.doesNotMatch(html, /<b>|<in 6 months>/, "entered text never becomes markup");
});

test("a save the API rejects keeps the form open with every entry", async () => {
  await openInductions();
  await page.getByRole("button", { name: "Add Record" }).click();
  await dialog().getByPlaceholder("Full name").fill("Robin Overlong");
  await fieldInput("Start Date").fill(today);
  const [first] = await sections();
  await first.getByRole("button", { name: "Yes", exact: true }).click();
  await first.locator("input").fill("Fire exits shown");
  // The API caps sign-off notes at 2,000 characters.
  await fieldInput("Notes / Sign-off Comments").fill("x".repeat(2_050));
  await dialog().getByRole("button", { name: "Create" }).click();
  await page.getByText("Could not save").first().waitFor();
  assert.ok(await dialog().isVisible(), "the form stays open");
  assert.equal(await dialog().getByPlaceholder("Full name").inputValue(), "Robin Overlong");
  assert.equal(await first.locator("input").inputValue(), "Fire exits shown", "topic entries are kept");
  assert.equal((await fieldInput("Notes / Sign-off Comments").inputValue()).length, 2_050, "nothing typed is lost");
  const { data } = await owner.request("GET", "/safe-track/inductions");
  assert.equal(data.some(item => item.staffName === "Robin Overlong"), false);
});
