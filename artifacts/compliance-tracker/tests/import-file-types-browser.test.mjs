import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for what an import accepts (components/import-csv-dialog.tsx,
// spreadsheet-drop-zone.tsx, ai-list-reader.tsx), on the contractors import:
//   - with the AI add-on, the main box also takes a photo, screenshot or PDF
//     (its file picker lists them) and sends it to the AI reader;
//   - a screenshot pasted with Ctrl+V is read by AI;
//   - cells pasted from Excel (text plus a picture) are imported as rows,
//     never sent to AI;
//   - a spreadsheet dropped on the AI box goes the usual spreadsheet way;
//   - an old Word (.doc) table is read in the browser;
//   - pasting into a text box is left alone;
//   - without the add-on, a pasted screenshot gets a plain message and the
//     picker lists only spreadsheets.
// API responses mirror artifacts/api-server/src/routes/csv-imports.ts.
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


// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
const aiStatus = active => ({
  configured: true, active, plan: active ? "addon" : "none", percentUsed: 10, resetsAt: "2026-11-01T00:00:00.000Z", usedUp: false,
  carriedOverPercent: 0, nextLapseAt: null, nextLapsePercent: 0,
});
const READ_HEADERS = ["Contact name", "Email", "Company", "Phone", "Trades", "Notes"];

async function open(aiActive) {
  const requests = [];
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
      user: { id: 5, email: "owner@example.test", name: "Owner", role: "client_admin", clientId: 23, departmentId: null, active: true, totpEnabled: true },
      billingLocked: false, client: { id: 23, name: "Import Test Client", slug: "import-test", logoUrl: null, primaryColor: "#2F7C8C", active: true },
      services: [],
    });
    if (url.pathname === "/api/imports/list-reading/contractors") return json(route, { available: true, monthlyLimit: 10, usedThisMonth: 1, ai: aiStatus(aiActive), sites: [] });
    if (url.pathname === "/api/imports/list-reading/contractors/read") {
      return json(route, { headers: READ_HEADERS, rows: [["Jo Spark", "jo@spark.test", "Spark Ltd", "", "Electrical", ""]], unclear: 0, unclearRows: [] });
    }
    if (url.pathname === "/api/imports/contractors" && method === "POST") {
      const rows = body.rows.map((row, index) => ({ row: index + 2, action: "create", label: row[0], reasons: [] }));
      return json(route, { preview: true, committed: false, summary: { total: rows.length, create: rows.length, update: 0, skip: 0, error: 0 }, rows, ignoredHeaders: [] });
    }
    return json(route, {});
  });
  await page.goto(`${baseUrl}/tests/import-file-types-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("button-import-contractors").click();
  if (aiActive) await page.getByTestId("button-list-reading-contractors").waitFor();
  else await page.getByTestId("list-reading-contractors").waitFor();
  return { page, requests, pageErrors };
}

/** Pastes onto `selector` the way Ctrl+V would: `files` are {name, type} made from the PNG bytes, `text` is text/plain. */
function paste(page, selector, { files = [], text } = {}) {
  return page.evaluate(({ selector, files, text, bytes }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([new Uint8Array(bytes)], file.name, { type: file.type }));
    if (text !== undefined) transfer.setData("text/plain", text);
    const target = document.querySelector(selector) ?? document.body;
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { selector, files, text, bytes: [...PNG] });
}

function drop(page, testId, file) {
  return page.evaluate(({ testId, file, bytes }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([typeof file.text === "string" ? file.text : new Uint8Array(file.bytes ?? bytes)], file.name, { type: file.type }));
    const target = document.querySelector(`[data-testid="${testId}"]`);
    if (!target) throw new Error(`No element for ${testId}`);
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { testId, file, bytes: [...PNG] });
}

const reads = requests => requests.filter(r => r.method === "POST" && r.path === "/api/imports/list-reading/contractors/read");
const previews = requests => requests.filter(r => r.method === "POST" && r.path === "/api/imports/contractors");
async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${what}`);
}
async function chooseAnother(page) {
  await page.getByRole("button", { name: "Choose another file" }).click();
  await page.getByTestId("input-contractors-file-drop").waitFor();
}

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });

  // With the AI add-on.
  {
    const { page, requests, pageErrors } = await open(true);
    const accept = await page.getByTestId("input-contractors-file").getAttribute("accept");
    for (const type of [".xlsx", ".xls", ".csv", ".ods", "image/*", ".pdf", ".heic"]) assert.ok(accept.split(",").includes(type), `main picker lists ${type}`);
    assert.match(await page.getByTestId("input-contractors-file-drop").innerText(), /spreadsheet, photo or PDF/);

    // A pasted screenshot is read by AI, then previewed.
    assert.equal(await paste(page, "[role=dialog]", { files: [{ name: "image.png", type: "image/png" }] }), true);
    await waitFor(() => previews(requests).length === 1, "the read rows to be previewed");
    assert.equal(reads(requests).length, 1);
    assert.equal(reads(requests)[0].body.mimeType, "image/png");
    assert.equal(reads(requests)[0].body.fileName, "pasted-screenshot.png");
    assert.deepEqual(previews(requests)[0].body.headers, READ_HEADERS);
    await page.getByTestId("list-read-note-contractors").waitFor();
    await chooseAnother(page);

    // A PDF dropped on the main box is read by AI too.
    await drop(page, "input-contractors-file-drop", { name: "contractors.pdf", type: "application/pdf" });
    await waitFor(() => reads(requests).length === 2 && previews(requests).length === 2, "the PDF to be read");
    assert.equal(reads(requests)[1].body.mimeType, "application/pdf");
    await chooseAnother(page);

    // Cells copied from Excel come as text plus a picture: the rows win and AI isn't used.
    assert.equal(await paste(page, "[role=dialog]", { files: [{ name: "image.png", type: "image/png" }], text: "Contact name\tEmail\nAl Pipe\tal@pipe.test\n" }), true);
    await waitFor(() => previews(requests).length === 3, "the pasted cells to be previewed");
    assert.equal(reads(requests).length, 2, "pasted Excel cells are not sent to AI");
    assert.deepEqual(previews(requests)[2].body.headers, ["Contact name", "Email"]);
    assert.deepEqual(previews(requests)[2].body.rows, [["Al Pipe", "al@pipe.test"]]);
    await chooseAnother(page);

    // A spreadsheet dropped on the AI box goes the usual way.
    await drop(page, "list-reading-contractors", { name: "contractors.csv", type: "text/csv", text: "Contact name,Email\nBea Gas,bea@gas.test\n" });
    await waitFor(() => previews(requests).length === 4, "the CSV to be previewed");
    assert.equal(reads(requests).length, 2, "a CSV dropped on the AI box is not sent to AI");
    assert.deepEqual(previews(requests)[3].body.rows, [["Bea Gas", "bea@gas.test"]]);
    await chooseAnother(page);

    // An old Word (.doc) table is read in the browser, never sent to AI.
    await drop(page, "input-contractors-file-drop", { name: "contacts.doc", type: "application/msword", bytes: [...readFileSync(new URL("fixtures/word-doc/fields.doc", import.meta.url))] });
    await waitFor(() => previews(requests).length === 5, "the .doc table to be previewed");
    assert.equal(reads(requests).length, 2, "a .doc file is not sent to AI");
    assert.deepEqual(previews(requests)[4].body.headers, ["Name", "Email"]);
    assert.deepEqual(previews(requests)[4].body.rows, [["Kim Lee", "kim@example.test"]]);
    await chooseAnother(page);

    // Pasting into a text box is left alone.
    assert.equal(await paste(page, "[data-testid=harness-text-box]", { text: "a\tb\nc\td" }), false);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(previews(requests).length, 5);
    assert.deepEqual(pageErrors, []);
    await page.close();
  }

  // Without the AI add-on.
  {
    const { page, requests, pageErrors } = await open(false);
    const accept = await page.getByTestId("input-contractors-file").getAttribute("accept");
    assert.ok(!accept.includes("image") && !accept.includes(".pdf"), "picker lists only spreadsheets without AI");
    assert.ok(accept.includes(".xls") && accept.includes(".csv"));
    await paste(page, "[role=dialog]", { files: [{ name: "image.png", type: "image/png" }] });
    await page.getByText(/needs the AI features add-on/).first().waitFor();
    assert.equal(reads(requests).length, 0);
    assert.equal(previews(requests).length, 0);
    // Excel cells still paste in.
    await paste(page, "[role=dialog]", { text: "Contact name\tEmail\nAl Pipe\tal@pipe.test" });
    await waitFor(() => previews(requests).length === 1, "the pasted cells to be previewed");
    assert.deepEqual(pageErrors, []);
  }
  console.log("Import file type browser checks passed: spreadsheet, photo, screenshot, PDF, pasted screenshot, pasted Excel cells and an old Word (.doc) table.");
} catch (error) {
  console.error("Import dialog:", browser ? await browser.contexts().at(-1)?.pages().at(-1)?.locator("body").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
