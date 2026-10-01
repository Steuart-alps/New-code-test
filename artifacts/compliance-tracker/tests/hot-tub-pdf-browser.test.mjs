import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";
import { getDocument } from "../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const standardFontDataUrl = new URL("../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname;
const browserName = process.env.HOT_TUB_BROWSER ?? "chromium";
const browserTypes = { chromium, firefox, webkit };
const browserType = browserTypes[browserName];
const port = 23000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const browserExecutablePath = browserName === "chromium"
  ? process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium"
  : process.env.HOT_TUB_BROWSER_EXECUTABLE_PATH;

if (!browserType) {
  throw new Error(`Unsupported HOT_TUB_BROWSER=${browserName}; expected chromium, firefox, or webkit`);
}

const activeTub = {
  id: 701,
  clientId: 42,
  siteId: 11,
  siteName: "Main site",
  name: "Active browser tub",
  description: null,
  active: true,
  createdAt: "2024-01-01T00:00:00.000Z",
};
const inactiveTub = {
  id: 702,
  clientId: 42,
  siteId: 11,
  siteName: "Main site",
  name: "Inactive browser tub",
  description: null,
  active: false,
  createdAt: "2024-01-01T00:00:00.000Z",
};
const otherActiveTub = {
  id: 703,
  clientId: 42,
  siteId: 22,
  siteName: "Other site",
  name: "Other active tub",
  description: null,
  active: true,
  createdAt: "2024-01-01T00:00:00.000Z",
};

function makeCheck(id, overrides = {}) {
  return {
    id,
    clientId: 42,
    siteId: 11,
    hotTubId: activeTub.id,
    checkType: "water_chemistry",
    checkDate: "2024-07-01T12:00:00.000Z",
    result: "pass",
    session: "morning",
    phValue: "7.4",
    sanitiserLevel: "3.8",
    temperature: "38.2",
    location: "Plant room",
    performedBy: "Browser Test Operator",
    notes: "outside-search-filter",
    createdAt: "2024-07-01T12:00:00.000Z",
    ...overrides,
  };
}

const expectedRows = Array.from({ length: 125 }, (_, index) => {
  const day = String((index % 31) + 1).padStart(2, "0");
  const marker = `CHECKROW${String(index + 1).padStart(3, "0")}`;
  return makeCheck(index + 1, {
    checkDate: `2024-07-${day}T12:00:00.000Z`,
    notes: index === 0
      ? `needle-search-filter ${marker} LONGNOTE_HEAD_MARKER ${"long maintenance detail ".repeat(600)} LONGNOTE_EXPLICIT_TAIL_MARKER_153`
      : `needle-search-filter ${marker}`,
  });
});
const excludedRows = [
  makeCheck(126, {
    checkDate: "2024-06-30T12:00:00.000Z",
    notes: "needle-search-filter EXCLUDED-BEFORE-DATE",
  }),
  makeCheck(127, {
    checkDate: "2024-08-01T12:00:00.000Z",
    notes: "needle-search-filter EXCLUDED-AFTER-DATE",
  }),
  makeCheck(128, {
    siteId: 22,
    hotTubId: otherActiveTub.id,
    notes: "needle-search-filter EXCLUDED-OTHER-SITE",
  }),
  makeCheck(129, {
    hotTubId: inactiveTub.id,
    notes: "needle-search-filter EXCLUDED-OTHER-TUB",
  }),
  makeCheck(130, {
    checkType: "temperature",
    notes: "needle-search-filter EXCLUDED-OTHER-TYPE",
  }),
  makeCheck(131, {
    notes: "EXCLUDED-SEARCH-TERM",
  }),
];
const checks = [...expectedRows, ...excludedRows];
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: {
    ...process.env,
    LD_AUDIT: "",
    REPLIT_LD_LIBRARY_PATH: "",
    PORT: String(port),
    BASE_PATH: "/",
    NODE_ENV: "test",
    REPL_ID: undefined,
  },
  stdio: ["ignore", "ignore", "ignore"],
});

let browser;
let context;
let page;
let temporaryDirectory;
const consoleDiagnostics = [];
const pageErrors = [];

async function waitForServer(timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/hot-tub`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Vite test server did not start");
}

function jsonResponse(route, data, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

function compact(text) {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
}

async function readPdf(filePath) {
  const bytes = await readFile(filePath);
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-", "download must contain PDF bytes");
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
  });
  try {
    const document = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const pdfPage = await document.getPage(pageNumber);
      const content = await pdfPage.getTextContent();
      pages.push(content.items.map(item => ("str" in item ? item.str : "")).join(" "));
    }
    return { bytes, pages, text: pages.join("\n") };
  } finally {
    await loadingTask.destroy();
  }
}

async function downloadPdf(label) {
  const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  assert.match(filename, /^[^/\\]+\.pdf$/i, `${label} download should have a .pdf filename`);
  const filePath = join(temporaryDirectory, `${label}.pdf`);
  await download.saveAs(filePath);
  return { filename, ...await readPdf(filePath) };
}

try {
  await waitForServer();
  try {
    browser = await browserType.launch({
      headless: true,
      executablePath: browserExecutablePath,
    });
  } catch (error) {
    throw new Error(
      `Required ${browserName} browser runtime is unavailable${browserExecutablePath ? ` at ${browserExecutablePath}` : ""}: ${error.message}`,
      { cause: error },
    );
  }

  context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  page.on("console", message => {
    if (message.type() === "warning" || message.type() === "error") {
      consoleDiagnostics.push(`[browser:${message.type()}] ${message.text()}`);
    }
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__pdfForbiddenCalls = [];
    window.open = () => {
      window.__pdfForbiddenCalls.push("window.open");
      throw new Error("PDF export must not call window.open");
    };
    window.print = () => {
      window.__pdfForbiddenCalls.push("window.print");
      throw new Error("PDF export must not call window.print");
    };
  });
  temporaryDirectory = await mkdtemp(join(tmpdir(), "hot-tub-pdf-browser-"));

  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    const { pathname, searchParams } = url;
    const isDocument = route.request().resourceType() === "document";
    const isHotTubApiRequest = !isDocument && [
      "/hot-tub",
      "/api/hot-tub",
      "/hot-tub/status",
      "/api/hot-tub/status",
    ].includes(pathname);

    if (pathname === "/api/auth/me") {
      return jsonResponse(route, {
        user: {
          id: 7,
          email: "manager@example.test",
          name: "Browser Manager",
          role: "client_admin",
          clientId: 42,
          departmentId: null,
          active: true,
          totpEnabled: true,
        },
        client: {
          id: 42,
          name: "Browser Fixture Client",
          slug: "browser-fixture-client",
          logoUrl: null,
          primaryColor: "#2F7C8C",
          active: true,
        },
        services: ["hottubtrack"],
      });
    }
    if (pathname === "/sites" || pathname === "/api/sites") {
      return jsonResponse(route, [{ id: 11, name: "Main site" }, { id: 22, name: "Other site" }]);
    }
    if (pathname === "/hot-tub/tubs" || pathname === "/api/hot-tub/tubs") {
      const active = searchParams.get("active");
      const tubs = active === "true"
        ? [activeTub, otherActiveTub]
        : active === "false"
          ? [inactiveTub]
          : [activeTub, inactiveTub, otherActiveTub];
      return jsonResponse(route, tubs);
    }
    if (isHotTubApiRequest) {
      return jsonResponse(route, pathname.endsWith("/hot-tub") ? checks : []);
    }
    if (pathname === "/hot-tub/config" || pathname === "/api/hot-tub/config") {
      return jsonResponse(route, {
        siteId: null,
        operatingRanges: {
          ph: { min: 7.2, max: 7.8 },
          sanitiser: { min: 3, max: 5 },
          temperature: { max: 40 },
        },
      });
    }
    if (pathname === "/hot-tub/monitoring-plan" || pathname === "/api/hot-tub/monitoring-plan") {
      return jsonResponse(route, {
        profile: {
          reviewRequired: false,
          riskAssessmentReference: null,
          writtenSchemeReference: null,
          competentPerson: null,
        },
        approved: false,
      });
    }
    if (pathname === "/api/photos") {
      return jsonResponse(route, []);
    }
    return route.continue();
  });

  const navigation = await page.goto(`${baseUrl}/hot-tub`);
  if (!navigation?.ok()) {
    throw new Error(`HotTub PDF browser navigation failed: ${navigation?.status() ?? "no response"}`);
  }

  await page.locator("#hot-tub-filter-from").fill("2024-07-01");
  await page.locator("#hot-tub-filter-to").fill("2024-07-31");
  await page.getByRole("button", { name: activeTub.name, exact: true }).click();

  const filterPanel = page.getByPlaceholder("Search tubs, checks, staff…").locator("xpath=../..");
  const filterComboboxes = filterPanel.getByRole("combobox");
  await filterComboboxes.nth(0).click();
  await page.getByRole("option", { name: "Main site", exact: true }).click();
  await filterComboboxes.nth(1).click();
  await page.getByRole("option", { name: "Water chemistry test (pH & sanitiser)", exact: true }).click();
  await page.getByPlaceholder("Search tubs, checks, staff…").fill("needle-search-filter");

  await page.getByText(`Showing ${expectedRows.length} of ${checks.length} records`, { exact: true })
    .waitFor({ state: "visible" });
  const populatedPdf = await downloadPdf("filtered-log");
  const populatedText = populatedPdf.text;
  assert.ok(populatedPdf.bytes.length > 1000, "PDF download should not be empty");
  assert.ok(populatedText.includes("Hot Tub & Spa Maintenance Log"), "PDF should have the maintenance log title");
  assert.ok(populatedText.includes("Browser Manager"), "PDF should show the generated-by name");
  const generatedDate = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());
  assert.ok(
    populatedText.toLowerCase().includes(`generated ${generatedDate}`.toLowerCase()),
    `PDF should include its generated date (${generatedDate})`,
  );
  assert.ok(populatedText.includes("Tub: Active browser tub"), "PDF should describe the selected tub");
  assert.ok(populatedText.includes("Site: Main site"), "PDF should describe the selected site");
  assert.ok(populatedText.includes("Check type: Water chemistry test"), "PDF should describe the selected check type");
  assert.ok(
    populatedText.includes('Search: "needle-search-filter"'),
    "PDF should describe the applied search filter",
  );
  const formatDate = date => new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00.000Z`));
  const expectedRange = `Date range: ${formatDate("2024-07-01")} to ${formatDate("2024-07-31")}`;
  assert.ok(populatedText.includes(expectedRange), `PDF should describe the selected range (${expectedRange})`);
  assert.ok(populatedText.includes(`Records: ${expectedRows.length}`), "PDF should report the filtered record count");

  assert.ok(populatedPdf.pages.length > 1, "more than 100 records should paginate onto multiple PDF pages");
  const headers = [
    "Date",
    "Session",
    "Site",
    "Tub",
    "Check",
    "Result",
    "pH",
    "Sanitiser (ppm)",
    "Temp (°C)",
    "Location",
    "Performed by",
    "Notes",
  ];
  for (const [index, pageText] of populatedPdf.pages.entries()) {
    const normalizedPage = compact(pageText);
    for (const header of headers) {
      assert.ok(
        normalizedPage.includes(compact(header)),
        `PDF page ${index + 1} should repeat the "${header}" maintenance table heading`,
      );
    }
  }
  for (let index = 0; index < expectedRows.length; index += 1) {
    const marker = `CHECKROW${String(index + 1).padStart(3, "0")}`;
    assert.ok(populatedText.includes(marker), `PDF should contain expected record ${marker}`);
  }
  const longNoteHeadPage = populatedPdf.pages.findIndex(text => text.includes("LONGNOTE_HEAD_MARKER"));
  const longNoteTailPage = populatedPdf.pages.findIndex(text => text.includes("LONGNOTE_EXPLICIT_TAIL_MARKER_153"));
  assert.ok(longNoteHeadPage >= 0, "PDF should retain the beginning of the long note");
  assert.ok(longNoteTailPage > longNoteHeadPage, "PDF should retain the tail of a note that spans pages");
  for (const row of excludedRows) {
    assert.ok(!populatedText.includes(row.notes), `PDF should exclude ${row.notes}`);
  }

  const forbiddenCalls = await page.evaluate(() => window.__pdfForbiddenCalls);
  assert.deepEqual(forbiddenCalls, [], "PDF export must not open a popup or invoke print");
  assert.equal(context.pages().length, 1, "PDF export must not open a popup page");

  await page.getByPlaceholder("Search tubs, checks, staff…").fill("empty-export-no-matches");
  await page.getByText("No records match the current filter.", { exact: true }).waitFor({ state: "visible" });
  const emptyPdf = await downloadPdf("empty-log");
  assert.ok(emptyPdf.text.includes("Hot Tub & Spa Maintenance Log"), "empty export should retain its report title");
  assert.ok(emptyPdf.text.includes("Records: 0"), "empty export should report zero records");
  assert.ok(
    emptyPdf.text.includes("No records match the current filter"),
    "empty export should explain that no records match",
  );
  assert.equal(emptyPdf.pages.length, 1, "empty export should be a valid single-page PDF");
  assert.deepEqual(await page.evaluate(() => window.__pdfForbiddenCalls), []);

  console.log(`HotTub PDF ${browserName} browser regression passed (${expectedRows.length} filtered rows, ${populatedPdf.pages.length} PDF pages).`);
} catch (error) {
  if (page) {
    console.error("HotTub PDF browser URL at failure:", page.url());
    console.error("HotTub PDF browser HTML at failure:", (await page.content()).slice(0, 4000));
  }
  for (const diagnostic of consoleDiagnostics) console.error(diagnostic);
  for (const errorMessage of pageErrors) console.error(`[browser:error] ${errorMessage}`);
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  vite.kill("SIGTERM");
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}