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
// Boundary probes have distinctive field values, so headers alone cannot satisfy
// the evidence checks. Use midnight and the final millisecond of the end date.
expectedRows[30] = makeCheck(31, {
  checkDate: "2024-07-31T23:59:59.999Z",
  phValue: "6.83",
  sanitiserLevel: "2.45",
  temperature: "41.25",
  result: "fail",
  performedBy: "Boundary End Operator",
  notes: "needle-search-filter CHECKROW031 FIELDPROBE end-date corrective action",
});
expectedRows[31] = makeCheck(32, {
  checkDate: "2024-07-01T00:00:00.000Z",
  phValue: "7.61",
  sanitiserLevel: "4.17",
  temperature: "38.56",
  result: "pass",
  performedBy: "Boundary Start Operator",
  notes: "needle-search-filter CHECKROW032 FIELDPROBE start-date normal operation",
});
const excludedRows = [
  makeCheck(126, {
    checkDate: "2024-06-30T23:59:59.999Z",
    notes: "needle-search-filter EXCLUDED-BEFORE-DATE",
  }),
  makeCheck(127, {
    checkDate: "2024-08-01T00:00:00.000Z",
    notes: "needle-search-filter EXCLUDED-AFTER-DATE",
  }),
  makeCheck(128, {
    checkDate: "2024-07-01T00:00:00.000Z",
    siteId: 22,
    hotTubId: otherActiveTub.id,
    notes: "needle-search-filter EXCLUDED-OTHER-SITE",
  }),
  makeCheck(129, {
    hotTubId: inactiveTub.id,
    notes: "needle-search-filter EXCLUDED-OTHER-TUB",
  }),
  makeCheck(130, {
    checkDate: "2024-07-31T23:59:59.999Z",
    checkType: "temperature",
    notes: "needle-search-filter EXCLUDED-OTHER-TYPE",
  }),
  makeCheck(131, {
    notes: "EXCLUDED-SEARCH-TERM",
  }),
];
const checks = [...expectedRows, ...excludedRows];

// Synthetic multilingual fixture (no customer data), served after the
// default fixture's checks by switching `fixture` and reloading the page.
const multilingualSites = [{ id: 44, name: "Ωμέγα Spa Αθήνα" }, { id: 55, name: "Санаторий Łódź" }];
const multilingualTub = {
  ...activeTub, id: 801, siteId: 44, siteName: multilingualSites[0].name, name: "Zoë Ångström Jacuzzi",
};
const multilingualOtherTub = {
  ...activeTub, id: 802, siteId: 55, siteName: multilingualSites[1].name, name: "Ванна Ελένη",
};
const multilingualStaff = ["Zoë Ångström", "Łukasz Żółkiewski", "Ελένη Παπαδοπούλου", "Тест Иванова"];
const multilingualRows = Array.from({ length: 70 }, (_, index) => {
  const marker = `MLROW${String(index + 1).padStart(3, "0")}`;
  return makeCheck(1001 + index, {
    siteId: 44,
    hotTubId: multilingualTub.id,
    checkDate: `2024-07-${String((index % 31) + 1).padStart(2, "0")}T09:00:00.000Z`,
    location: "Σάουνα / Сауна",
    performedBy: multilingualStaff[index % multilingualStaff.length],
    notes: index === 0
      ? `UnicodeProbe Тест ${marker} ΑΡΧΗ_ΣΗΜΕΙΩΣΗΣ ${"Długa notatka — длинная заметка — μακρά σημείωση ".repeat(300)}КОНЕЦ_ЗАМЕТКИ_ΤΕΛΟΣ`
      : `UnicodeProbe Тест ${marker} Ελληνικά Łódź Zoë`,
  });
});
// Decomposed input (e + combining diaeresis) must come out composed.
multilingualRows[1].performedBy = "Zoe\u0308 Decomposed";
const multilingualOtherSiteRow = makeCheck(1071, {
  siteId: 55,
  hotTubId: multilingualOtherTub.id,
  notes: "UnicodeProbe Тест MLROW071 other site",
});
const unsupportedRow = makeCheck(1072, {
  siteId: 44,
  hotTubId: multilingualTub.id,
  notes: "UnicodeProbe Тест UNSUPPORTED_ROW_SECRET 漢字 🙂",
});
const multilingualChecks = [...multilingualRows, multilingualOtherSiteRow, unsupportedRow];
const multilingualUserName = "Zoë Łukasz-Ελένη Тестова";
let fixture = "default";
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

// First-party analytics: every POST /api/analytics/events body is captured.
// `analyticsMode` decides the mocked response so the tests can prove the
// download never depends on analytics.
const ANALYTICS_EVENT = "inspection_pdf_download_started";
const ANALYTICS_DIMENSIONS = {
  module: ["hottubtrack"],
  site_scope: ["all_sites", "selected_site"],
  record_scope: ["empty", "has_records"],
};
const analyticsEvents = [];
const hungAnalyticsRoutes = [];
let analyticsMode = "ok";
let expectedAnalyticsEvents = 0;

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

async function readPdf(filePath, { fonts = false } = {}) {
  const bytes = await readFile(filePath);
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-", "download must contain PDF bytes");
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
  });
  try {
    const document = await loadingTask.promise;
    const pages = [];
    // With `fonts`, also record which font draws each text item.
    const pageItems = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const pdfPage = await document.getPage(pageNumber);
      if (fonts) await pdfPage.getOperatorList();
      const content = await pdfPage.getTextContent();
      pages.push(content.items.map(item => ("str" in item ? item.str : "")).join(" "));
      if (fonts) {
        pageItems.push(content.items.filter(item => item.str?.trim()).map(item => {
          const font = pdfPage.commonObjs.get(item.fontName);
          return { str: item.str, fontId: item.fontName, fontName: font.name, missingFile: font.missingFile };
        }));
      }
    }
    return { bytes, pages, pageItems, text: pages.join("\n") };
  } finally {
    await loadingTask.destroy();
  }
}

async function waitForAnalyticsCount(count, label) {
  const deadline = Date.now() + 5000;
  while (analyticsEvents.length < count && Date.now() < deadline) await page.waitForTimeout(25);
  assert.equal(analyticsEvents.length, count, `${label}: expected exactly ${count} analytics event(s) so far`);
}

// Every successful download records exactly one allowlisted event whose
// scopes match what was exported. `analytics: false` is for the run where the
// analytics fetch itself throws, so no request can reach the network.
async function downloadPdf(label, readOptions, { analytics = true } = {}) {
  const eventsBefore = analyticsEvents.length;
  const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  assert.match(filename, /^[^/\\]+\.pdf$/i, `${label} download should have a .pdf filename`);
  const filePath = join(temporaryDirectory, `${label}.pdf`);
  await download.saveAs(filePath);
  const pdf = { filename, ...await readPdf(filePath, readOptions) };
  if (!analytics) return pdf;

  expectedAnalyticsEvents += 1;
  await waitForAnalyticsCount(eventsBefore + 1, label);
  const event = analyticsEvents[eventsBefore];
  assert.deepEqual(Object.keys(event).sort(), ["dimensions", "event"], `${label}: analytics body shape`);
  assert.equal(event.event, ANALYTICS_EVENT, `${label}: analytics event name`);
  assert.deepEqual(Object.keys(event.dimensions).sort(), Object.keys(ANALYTICS_DIMENSIONS).sort(),
    `${label}: analytics must send exactly the allowlisted dimensions`);
  for (const [key, allowed] of Object.entries(ANALYTICS_DIMENSIONS)) {
    assert.ok(allowed.includes(event.dimensions[key]), `${label}: ${key}=${event.dimensions[key]} must be allowlisted`);
  }
  // The scopes must describe the exported report, nothing else.
  const recordCount = Number(pdf.text.match(/Records: (\d+)/)?.[1]);
  assert.ok(Number.isInteger(recordCount), `${label}: report should state its record count`);
  assert.equal(event.dimensions.record_scope, recordCount === 0 ? "empty" : "has_records",
    `${label}: record_scope must follow the exported row count`);
  assert.equal(event.dimensions.site_scope, pdf.text.includes("Site: ") ? "selected_site" : "all_sites",
    `${label}: site_scope must follow the site filter`);
  return { ...pdf, analytics: event.dimensions };
}

async function assertExportMembership(label, expectedIds) {
  const expected = new Set(expectedIds);
  await page.getByText(`Showing ${expected.size} of ${checks.length} records`, { exact: true })
    .waitFor({ state: "visible" });
  const pdf = await downloadPdf(label);
  assert.ok(pdf.text.includes(`Records: ${expected.size}`), `${label}: report count must match the UI`);
  for (const row of checks) {
    const marker = row.notes.match(/CHECKROW\d+|EXCLUDED-[A-Z-]+/)?.[0];
    assert.ok(marker, `fixture ${row.id} must have a unique report marker`);
    assert.equal(pdf.text.includes(marker), expected.has(row.id),
      `${label}: report membership of record ${row.id} (${marker})`);
  }
  assert.ok(pdf.text.includes("CHECKROW031"), `${label}: include the final millisecond of the end date`);
  assert.ok(pdf.text.includes("CHECKROW032"), `${label}: include midnight on the start date`);
  assert.ok(!pdf.text.includes("EXCLUDED-BEFORE-DATE"), `${label}: exclude the millisecond before the start date`);
  assert.ok(!pdf.text.includes("EXCLUDED-AFTER-DATE"), `${label}: exclude midnight after the end date`);
  return pdf;
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
  // One-shot fault hooks for the recovery checks. They stay inert until a test
  // arms them, and survive reloads because they are init scripts.
  await page.addInitScript(() => {
    window.__pdfFaults = { generate: 0, objectUrl: 0 };
    const NativeBlob = window.Blob;
    // jsPDF's output("blob") builds the final PDF Blob; failing it makes the
    // generator itself throw part-way through an export.
    window.Blob = new Proxy(NativeBlob, {
      construct(target, args, newTarget) {
        if (args[1]?.type === "application/pdf" && window.__pdfFaults.generate > 0) {
          window.__pdfFaults.generate -= 1;
          throw new TypeError("Simulated jsPDF serialisation failure");
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
    // downloadBlob saves through an object URL; fail that step once.
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = object => {
      if (object?.type === "application/pdf" && window.__pdfFaults.objectUrl > 0) {
        window.__pdfFaults.objectUrl -= 1;
        throw new DOMException("Simulated object URL failure", "NotReadableError");
      }
      return nativeCreateObjectURL(object);
    };
  });
  // Makes the page's own fetch throw synchronously for an armed analytics
  // request, simulating a broken fetch inside trackEvent.
  await page.addInitScript(() => {
    window.__analyticsFetch = { throwNext: 0, thrown: 0 };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/analytics/events") && window.__analyticsFetch.throwNext > 0) {
        window.__analyticsFetch.throwNext -= 1;
        window.__analyticsFetch.thrown += 1;
        throw new TypeError("Simulated analytics fetch failure");
      }
      return nativeFetch(input, init);
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

    if (pathname === "/api/auth/csrf-token") {
      return jsonResponse(route, { token: "csrf-test-token" });
    }
    if (pathname === "/api/analytics/events") {
      const request = route.request();
      assert.equal(request.method(), "POST", "analytics events must be POSTed");
      assert.equal(await request.headerValue("x-csrf-token"), "csrf-test-token", "analytics must use the CSRF token");
      analyticsEvents.push(JSON.parse(request.postData() ?? "null"));
      if (analyticsMode === "500") return jsonResponse(route, { error: "Analytics unavailable" }, 500);
      if (analyticsMode === "abort") return route.abort("failed");
      if (analyticsMode === "hang") return new Promise(resolve => hungAnalyticsRoutes.push({ route, resolve }));
      return route.fulfill({ status: 204 });
    }
    if (pathname === "/api/auth/me") {
      return jsonResponse(route, {
        user: {
          id: 7,
          email: "manager@example.test",
          name: fixture === "multilingual" ? multilingualUserName : "Browser Manager",
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
      return jsonResponse(route, fixture === "multilingual"
        ? multilingualSites
        : [{ id: 11, name: "Main site" }, { id: 22, name: "Other site" }]);
    }
    if (pathname === "/hot-tub/tubs" || pathname === "/api/hot-tub/tubs") {
      const active = searchParams.get("active");
      if (fixture === "multilingual") {
        return jsonResponse(route, active === "false" ? [] : [multilingualTub, multilingualOtherTub]);
      }
      const tubs = active === "true"
        ? [activeTub, otherActiveTub]
        : active === "false"
          ? [inactiveTub]
          : [activeTub, inactiveTub, otherActiveTub];
      return jsonResponse(route, tubs);
    }
    if (isHotTubApiRequest) {
      const fixtureChecks = fixture === "multilingual" ? multilingualChecks : checks;
      return jsonResponse(route, pathname.endsWith("/hot-tub") ? fixtureChecks : []);
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
  const inRangeIds = expectedRows.map(row => row.id);
  const datesOnlyPdf = await assertExportMembership("dates-only", [...inRangeIds, 128, 129, 130, 131]);
  assert.deepEqual(datesOnlyPdf.analytics, { module: "hottubtrack", site_scope: "all_sites", record_scope: "has_records" });

  const filterPanel = page.getByPlaceholder("Search tubs, checks, staff…").locator("xpath=../..");
  const filterComboboxes = filterPanel.getByRole("combobox");
  await filterComboboxes.nth(0).click();
  await page.getByRole("option", { name: "Main site", exact: true }).click();
  const datesAndSitePdf = await assertExportMembership("dates-and-site", [...inRangeIds, 129, 130, 131]);
  assert.deepEqual(datesAndSitePdf.analytics,
    { module: "hottubtrack", site_scope: "selected_site", record_scope: "has_records" });

  await filterComboboxes.nth(0).click();
  await page.getByRole("option", { name: "All sites", exact: true }).click();
  await filterComboboxes.nth(1).click();
  await page.getByRole("option", { name: "Water chemistry test (pH & sanitiser)", exact: true }).click();
  await assertExportMembership("dates-and-check-type", [...inRangeIds, 128, 129, 131]);
  await filterComboboxes.nth(0).click();
  await page.getByRole("option", { name: "Main site", exact: true }).click();
  await assertExportMembership("dates-site-and-check-type", [...inRangeIds, 129, 131]);

  await page.getByRole("button", { name: activeTub.name, exact: true }).click();
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

  // Inspect actual values in a small downloaded report, not just table headings
  // or evidence that the list screen contains them.
  await page.getByPlaceholder("Search tubs, checks, staff…").fill("FIELDPROBE");
  await page.getByText(`Showing 2 of ${checks.length} records`, { exact: true })
    .waitFor({ state: "visible" });
  const fieldPdf = await downloadPdf("boundary-evidence-fields");
  assert.ok(fieldPdf.text.includes("Records: 2"));
  for (const row of [expectedRows[30], expectedRows[31]]) {
    for (const [field, value] of Object.entries({
      pH: row.phValue,
      sanitiser: row.sanitiserLevel,
      temperature: row.temperature,
      staff: row.performedBy,
      result: row.result === "pass" ? "Pass" : "Fail",
      notes: row.notes,
    })) {
      assert.ok(fieldPdf.text.includes(value), `boundary record ${row.id}: export must retain ${field} value "${value}"`);
    }
  }
  assert.ok(fieldPdf.text.includes(formatDate("2024-07-01")));
  assert.ok(fieldPdf.text.includes(formatDate("2024-07-31")));
  assert.ok(!fieldPdf.text.includes("EXCLUDED-"), "evidence report must not leak excluded rows");
  assert.ok(!fieldPdf.text.includes("CHECKROW001"), "evidence report must apply its search filter");

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
  assert.deepEqual(emptyPdf.analytics, { module: "hottubtrack", site_scope: "selected_site", record_scope: "empty" });

  // The remaining scope combination: all sites, nothing matching.
  await filterComboboxes.nth(0).click();
  await page.getByRole("option", { name: "All sites", exact: true }).click();
  await page.getByText("No records match the current filter.", { exact: true }).waitFor({ state: "visible" });
  const emptyAllSitesPdf = await downloadPdf("empty-all-sites-log");
  assert.ok(emptyAllSitesPdf.text.includes("Records: 0"));
  assert.deepEqual(emptyAllSitesPdf.analytics, { module: "hottubtrack", site_scope: "all_sites", record_scope: "empty" });

  // ── Failure recovery in the export controls ─────────────────────────────────
  // Each fault fails exactly one attempt. The failed attempt must show an
  // actionable error, release "Preparing PDF…", and produce no download, popup
  // or print fallback. The retry runs under different filters and must export
  // the rows those filters select, not the rows of the failed attempt.
  const downloadEvents = [];
  const popupEvents = [];
  const dialogEvents = [];
  page.on("download", download => downloadEvents.push(download));
  page.on("dialog", dialog => {
    dialogEvents.push(`${dialog.type()}: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  page.on("popup", popup => popupEvents.push(popup));
  context.on("page", newPage => popupEvents.push(newPage));

  const siteNames = { 11: "Main site", 22: "Other site" };
  const tubNames = { [activeTub.id]: activeTub.name, [otherActiveTub.id]: otherActiveTub.name };
  const searchBox = page.getByPlaceholder("Search tubs, checks, staff…");
  const downloadButton = page.getByRole("button", { name: "Download PDF", exact: true });
  const failureToast = page.locator("li", { hasText: "PDF download failed" });

  function expectedIdsFor(filters) {
    // Search terms used here only occur in notes, so this mirrors the page.
    return checks.filter(row =>
      (filters.type === "all" || row.checkType === filters.type) &&
      (filters.site === "all" || row.siteId === filters.site) &&
      (filters.tub === "all" || row.hotTubId === filters.tub) &&
      row.checkDate.slice(0, 10) >= filters.from &&
      row.checkDate.slice(0, 10) <= filters.to &&
      (!filters.search || row.notes.toLowerCase().includes(filters.search.toLowerCase())),
    ).map(row => row.id);
  }

  async function applyFilters(filters) {
    await page.locator("#hot-tub-filter-from").fill(filters.from);
    await page.locator("#hot-tub-filter-to").fill(filters.to);
    await filterComboboxes.nth(0).click();
    await page.getByRole("option", { name: filters.site === "all" ? "All sites" : siteNames[filters.site], exact: true })
      .click();
    await filterComboboxes.nth(1).click();
    await page.getByRole("option", {
      name: filters.type === "all" ? "All check types" : "Water chemistry test (pH & sanitiser)",
      exact: true,
    }).click();
    await page.getByRole("button", { name: "All tubs", exact: true }).click();
    if (filters.tub !== "all") {
      await page.getByRole("button", { name: tubNames[filters.tub], exact: true }).click();
    }
    await searchBox.fill(filters.search);
    const count = expectedIdsFor(filters).length;
    await page.getByText(`Showing ${count} of ${checks.length} records`, { exact: true })
      .waitFor({ state: "visible" });
  }

  async function assertFailedAttempt(label, expectedMessage) {
    const downloadsBefore = downloadEvents.length;
    const analyticsBefore = analyticsEvents.length;
    await downloadButton.click();
    await failureToast.waitFor({ state: "visible", timeout: 20000 });
    assert.deepEqual(dialogEvents, [], `${label}: a failed attempt must not show a native dialog`);
    const message = (await failureToast.innerText()).replace(/\s+/g, " ");
    assert.match(message, expectedMessage, `${label}: the visible error should say how to recover`);
    // "Preparing PDF…" clears and the control is usable again.
    await downloadButton.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await downloadButton.isEnabled(), true, `${label}: Download PDF should be enabled again`);
    assert.equal(await downloadButton.getAttribute("aria-busy"), "false", `${label}: button should not stay busy`);
    assert.equal(await page.getByText("Preparing PDF…").count(), 0, `${label}: Preparing PDF should clear`);
    // Give any late download or fallback a chance to surface before checking.
    await page.waitForTimeout(750);
    assert.equal(downloadEvents.length, downloadsBefore, `${label}: a failed attempt must not download anything`);
    assert.equal(analyticsEvents.length, analyticsBefore, `${label}: a failed attempt must not record a download event`);
    assert.deepEqual(await page.evaluate(() => window.__pdfForbiddenCalls), [],
      `${label}: a failed attempt must not fall back to print or a popup`);
    assert.equal(popupEvents.length, 0, `${label}: a failed attempt must not open a popup`);
    assert.equal(context.pages().length, 1, `${label}: a failed attempt must not open another page`);
    return message;
  }

  async function assertRetryMatches(label, filters, staleFilters) {
    const downloadsBefore = downloadEvents.length;
    const expected = new Set(expectedIdsFor(filters));
    const pdf = await downloadPdf(label);
    assert.equal(downloadEvents.length, downloadsBefore + 1, `${label}: the retry should download exactly once`);
    // Radix would auto-close it after 5s; the retry itself must clear it.
    await failureToast.waitFor({ state: "hidden", timeout: 2000 }).catch(() => {
      throw new assert.AssertionError({ message: `${label}: a stale failure must not stay on screen after success` });
    });
    assert.ok(pdf.text.includes(`Records: ${expected.size}`), `${label}: report count must match the new filters`);
    for (const row of checks) {
      const marker = row.notes.match(/CHECKROW\d+|EXCLUDED-[A-Z-]+/)[0];
      assert.equal(pdf.text.includes(marker), expected.has(row.id),
        `${label}: report membership of record ${row.id} (${marker}) must follow the new filters`);
    }
    const range = `Date range: ${formatDate(filters.from)} to ${formatDate(filters.to)}`;
    const staleRange = `Date range: ${formatDate(staleFilters.from)} to ${formatDate(staleFilters.to)}`;
    assert.ok(pdf.text.includes(range), `${label}: report should describe the new range (${range})`);
    assert.ok(!pdf.text.includes(staleRange), `${label}: report must not describe the failed attempt's range`);
    assert.equal(pdf.text.includes("Site: "), filters.site !== "all", `${label}: site description`);
    if (filters.site !== "all") assert.ok(pdf.text.includes(`Site: ${siteNames[filters.site]}`));
    assert.equal(pdf.text.includes("Check type: "), filters.type !== "all", `${label}: check type description`);
    assert.equal(pdf.text.includes("Tub: "), filters.tub !== "all", `${label}: tub description`);
    assert.equal(pdf.text.includes("Search: "), Boolean(filters.search), `${label}: search description`);
    assert.deepEqual(await page.evaluate(() => window.__pdfForbiddenCalls), []);
    assert.equal(popupEvents.length, 0);
    assert.deepEqual(dialogEvents, []);
  }

  // (a) PDF generation throws once.
  const generationFailed = {
    from: "2024-07-01", to: "2024-07-31", site: 11, type: "water_chemistry", tub: activeTub.id,
    search: "needle-search-filter",
  };
  const generationRetry = { from: "2024-07-01", to: "2024-07-01", site: "all", type: "all", tub: "all", search: "" };
  await applyFilters(generationFailed);
  await page.evaluate(() => { window.__pdfFaults.generate = 1; });
  await assertFailedAttempt("generation failure", /could not be created.*try again/i);
  assert.equal(await page.evaluate(() => window.__pdfFaults.generate), 0, "generation fault should have fired");
  await applyFilters(generationRetry);
  await assertRetryMatches("generation-retry", generationRetry, generationFailed);

  // (b) Saving the generated blob fails once.
  const saveFailed = { from: "2024-07-01", to: "2024-07-31", site: 22, type: "all", tub: "all", search: "" };
  const saveRetry = {
    from: "2024-07-15", to: "2024-07-20", site: 11, type: "water_chemistry", tub: activeTub.id, search: "checkrow0",
  };
  await applyFilters(saveFailed);
  await page.evaluate(() => { window.__pdfFaults.objectUrl = 1; });
  await assertFailedAttempt("save failure", /could not be saved.*try again/i);
  assert.equal(await page.evaluate(() => window.__pdfFaults.objectUrl), 0, "save fault should have fired");
  await applyFilters(saveRetry);
  await assertRetryMatches("save-retry", saveRetry, saveFailed);

  // (c) The lazily loaded PDF module fails to download. It is already in this
  // page's module map, so start from a fresh document before aborting it.
  await page.reload();
  let chunkAborts = 0;
  await page.route(/\/node_modules\/\.vite\/deps\/jspdf\.js(\?|$)/, route => {
    if (chunkAborts === 0) {
      chunkAborts += 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });
  const chunkFailed = { from: "2024-07-01", to: "2024-07-01", site: "all", type: "all", tub: "all", search: "" };
  const chunkRetry = { from: "2024-07-31", to: "2024-08-01", site: 11, type: "all", tub: "all", search: "" };
  await applyFilters(chunkFailed);
  await assertFailedAttempt("module fetch failure", /reload the page/i);
  assert.equal(chunkAborts, 1, "the PDF module request should have been aborted once");
  // Chromium caches a failed dynamic import for the document's lifetime, so a
  // retry in place fails again with the same accurate instruction.
  await failureToast.locator("[toast-close]").click();
  await failureToast.waitFor({ state: "hidden", timeout: 5000 });
  await applyFilters(chunkRetry);
  await assertFailedAttempt("module fetch retry without reload", /reload the page/i);
  await page.reload();
  await applyFilters(chunkRetry);
  await assertRetryMatches("module-retry-after-reload", chunkRetry, chunkFailed);

  // ── Analytics never affects the download ────────────────────────────────────
  // The endpoint failing, aborting or never answering, or trackEvent's fetch
  // throwing, must leave the download, its button state and the page intact.
  await applyFilters({ from: "2024-07-01", to: "2024-07-31", site: 11, type: "all", tub: "all", search: "" });
  const pageErrorsBefore = pageErrors.length;
  async function assertAnalyticsIsolated(label, options) {
    const downloadsBefore = downloadEvents.length;
    const pdf = await downloadPdf(label, undefined, options);
    assert.equal(downloadEvents.length, downloadsBefore + 1, `${label}: exactly one download`);
    assert.ok(pdf.text.includes(`Records: ${expectedRows.length + 3}`), `${label}: the PDF must still be complete`);
    await downloadButton.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await downloadButton.isEnabled(), true, `${label}: Download PDF should be enabled again`);
    assert.equal(await downloadButton.getAttribute("aria-busy"), "false", `${label}: button should not stay busy`);
    await page.waitForTimeout(500);
    assert.equal(await failureToast.count(), 0, `${label}: an analytics problem must not show an error`);
    assert.equal(pageErrors.length, pageErrorsBefore, `${label}: an analytics problem must not raise page errors`);
    assert.equal(popupEvents.length, 0);
    assert.deepEqual(dialogEvents, []);
  }
  for (const mode of ["500", "abort", "hang"]) {
    analyticsMode = mode;
    await assertAnalyticsIsolated(`analytics-${mode}`);
  }
  assert.equal(hungAnalyticsRoutes.length, 1, "the hanging analytics request should still be pending");
  analyticsMode = "ok";
  await page.evaluate(() => { window.__analyticsFetch.throwNext = 1; });
  const analyticsBeforeThrow = analyticsEvents.length;
  await assertAnalyticsIsolated("analytics-fetch-throws", { analytics: false });
  assert.equal(await page.evaluate(() => window.__analyticsFetch.thrown), 1, "trackEvent's fetch should have thrown once");
  assert.equal(analyticsEvents.length, analyticsBeforeThrow, "a throwing fetch sends nothing");
  for (const { route, resolve } of hungAnalyticsRoutes.splice(0)) {
    await route.fulfill({ status: 204 }).catch(() => {});
    resolve();
  }

  // ── Multilingual text preservation ──────────────────────────────────────────
  // The embedded Noto Sans must keep non-Latin staff names, notes, site and tub
  // labels and search filters as real, extractable text, and refuse (with an
  // explicit error) characters it has no glyph for instead of dropping them.
  fixture = "multilingual";
  await page.reload();
  const multilingualSearch = "Тест MLROW";
  await page.locator("#hot-tub-filter-from").fill("2024-07-01");
  await page.locator("#hot-tub-filter-to").fill("2024-07-31");
  await filterComboboxes.nth(0).click();
  await page.getByRole("option", { name: multilingualSites[0].name, exact: true }).click();
  await page.getByRole("button", { name: multilingualTub.name, exact: true }).click();
  await searchBox.fill(multilingualSearch);
  await page.getByText(`Showing ${multilingualRows.length} of ${multilingualChecks.length} records`, { exact: true })
    .waitFor({ state: "visible" });

  // The fonts are fetched lazily with jsPDF; a failed font fetch reports the
  // same reload/try-again message, and a fetch failure is not cached, so the
  // next attempt in the same document succeeds.
  const fontRequests = [];
  let fontAborts = 0;
  const fontRoute = /\/NotoSans-(Regular|Bold)\.ttf(\?|$)/;
  await page.route(fontRoute, route => {
    fontRequests.push(route.request().url());
    if (fontAborts === 0 && /Bold/.test(route.request().url())) {
      fontAborts += 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });
  await assertFailedAttempt("font fetch failure", /could not be loaded.*reload the page/i);
  assert.equal(fontAborts, 1, "the bold font request should have been aborted once");
  await failureToast.locator("[toast-close]").click();
  await failureToast.waitFor({ state: "hidden", timeout: 5000 });

  const multilingualPdf = await downloadPdf("multilingual-log", { fonts: true });
  await page.unroute(fontRoute);
  assert.ok(fontRequests.some(url => /Regular/.test(url)) && fontRequests.some(url => /Bold/.test(url)),
    "both font faces should be fetched for an export");
  const mlText = multilingualPdf.text;
  // Every visible string (title, metadata, headings, cells, footer) is drawn
  // with an embedded Noto Sans face, never a built-in standard font. The bold
  // headings use a different embedded face from the regular body text.
  const allItems = multilingualPdf.pageItems.flat();
  for (const item of allItems) {
    assert.equal(item.fontName, "NotoSans", `"${item.str}" must use the embedded font, not ${item.fontName}`);
    assert.equal(item.missingFile, false, `"${item.str}" must use an embedded font file`);
  }
  const fontOf = text => allItems.find(item => item.str === text)?.fontId;
  const boldFont = fontOf("Performed by");
  const regularFont = fontOf("Pass");
  assert.ok(boldFont && regularFont && boldFont !== regularFont, "headings must use the bold face");
  assert.equal(fontOf("Hot Tub & Spa Maintenance Log"), boldFont, "the title must use the bold face");
  assert.equal(fontOf(`Records: ${multilingualRows.length}`), regularFont, "metadata must use the regular face");
  assert.equal(fontOf(`Page 1 of ${multilingualPdf.pages.length}`), regularFont, "the footer must use the regular face");
  assert.ok(mlText.includes("Hot Tub & Spa Maintenance Log"), "multilingual report keeps its title");
  assert.ok(mlText.includes(multilingualUserName), "generated-by name must survive as original text");
  assert.ok(mlText.includes(`Site: ${multilingualSites[0].name}`), "site filter label must survive");
  assert.ok(mlText.includes(`Tub: ${multilingualTub.name}`), "tub filter label must survive");
  assert.ok(mlText.includes(`Search: "${multilingualSearch}"`), "search filter must survive");
  assert.ok(mlText.includes(`Records: ${multilingualRows.length}`), "record count must match the UI");
  assert.ok(mlText.includes("UnicodeProbe Тест"), "the UnicodeProbe Тест cell text must be preserved");
  // Narrow columns wrap words (even mid-word), so compare these cells with
  // whitespace removed; every original character must still be present.
  const squash = text => text.replace(/\s+/g, "");
  const mlSquashed = squash(mlText);
  for (const name of multilingualStaff) {
    assert.ok(mlSquashed.includes(squash(name)), `staff name "${name}" must survive as original text`);
  }
  assert.ok(mlSquashed.includes(squash("Zoë Decomposed")), "decomposed input must be exported in composed form");
  assert.ok(mlSquashed.includes(squash(multilingualTub.name)), "tub label cells must survive");
  assert.ok(mlSquashed.includes(squash(multilingualSites[0].name)), "site label cells must survive");
  assert.ok(mlSquashed.includes(squash("Σάουνα / Сауна")), "location cells must survive");
  for (const row of multilingualRows.slice(1)) {
    assert.ok(mlText.includes(row.notes), `note "${row.notes}" must survive as original text`);
  }
  assert.ok(!mlText.includes("MLROW071"), "the other site's record must be excluded");
  assert.ok(!mlText.includes("UNSUPPORTED_ROW_SECRET"), "the unmatched record must be excluded");

  // Pagination: every page repeats the headings and numbers itself, and the
  // long multilingual note runs across pages with its head and tail intact.
  const mlPages = multilingualPdf.pages;
  assert.ok(mlPages.length > 2, "the long multilingual note should span several pages");
  for (const [index, pageText] of mlPages.entries()) {
    assert.ok(pageText.includes(`Page ${index + 1} of ${mlPages.length}`), `page ${index + 1} footer`);
    assert.ok(pageText.includes("Hot Tub & Spa Maintenance Log"), `page ${index + 1} title`);
    for (const header of headers) {
      assert.ok(compact(pageText).includes(compact(header)), `page ${index + 1} should repeat "${header}"`);
    }
  }
  const mlHeadPage = mlPages.findIndex(text => text.includes("ΑΡΧΗ_ΣΗΜΕΙΩΣΗΣ"));
  const mlTailPage = mlPages.findIndex(text => text.includes("КОНЕЦ_ЗАМЕТКИ_ΤΕΛΟΣ"));
  assert.ok(mlHeadPage >= 0, "the long note's beginning must survive");
  assert.ok(mlTailPage > mlHeadPage, "the long note's end must survive on a later page");
  assert.ok(mlPages.slice(mlHeadPage, mlTailPage + 1).every(text => text.includes("длинная заметка")),
    "every page the long note spans must carry its Cyrillic text");
  assert.ok(mlText.includes("Długa notatka — длинная заметка — μακρά σημείωση"),
    "a full line of the long note must survive");

  // A record with characters outside the embedded font blocks the export with
  // an explicit, actionable error that names the characters, not the record.
  await searchBox.fill("Тест");
  await page.getByText(`Showing ${multilingualRows.length + 1} of ${multilingualChecks.length} records`, { exact: true })
    .waitFor({ state: "visible" });
  const unsupportedMessage = await assertFailedAttempt("unsupported characters", /PDF font cannot show/i);
  for (const fragment of ['"漢" (U+6F22)', '"字" (U+5B57)', '"🙂" (U+1F642)', "try again"]) {
    assert.ok(unsupportedMessage.includes(fragment), `unsupported-character error should include ${fragment}`);
  }
  for (const secret of ["UNSUPPORTED_ROW_SECRET", "UnicodeProbe"]) {
    assert.ok(!unsupportedMessage.includes(secret), "the error must not reveal record content");
  }
  // Leaving the record out lets the export succeed again.
  await searchBox.fill(multilingualSearch);
  await page.getByText(`Showing ${multilingualRows.length} of ${multilingualChecks.length} records`, { exact: true })
    .waitFor({ state: "visible" });
  const recoveredPdf = await downloadPdf("multilingual-after-unsupported");
  await failureToast.waitFor({ state: "hidden", timeout: 2000 });
  assert.ok(recoveredPdf.text.includes(`Records: ${multilingualRows.length}`));
  assert.deepEqual(await page.evaluate(() => window.__pdfForbiddenCalls), []);
  assert.deepEqual(dialogEvents, []);
  assert.equal(popupEvents.length, 0);

  await page.waitForTimeout(500);
  assert.equal(analyticsEvents.length, expectedAnalyticsEvents,
    "exactly one analytics event per successful download, and none for failed attempts");

  console.log(`HotTub PDF ${browserName} browser regression passed (${expectedRows.length} filtered rows, ${populatedPdf.pages.length} PDF pages, ${analyticsEvents.length} analytics events).`);
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