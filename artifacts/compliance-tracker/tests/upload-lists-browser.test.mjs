import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for "Upload your lists" (src/pages/upload-lists.tsx):
//   - several files dropped at once are each sorted into an import: a
//     spreadsheet by its headings, a photo by AI (POST /imports/sort-list),
//     a PDF by its file name (no AI), and an unclear one asks the person;
//   - "Check and import" opens the import's own dialog with the file already
//     in it (contractors preview, call points read by AI, GreenTrack
//     machines, the staff roster), and an import marks the file done;
//   - without the AI add-on, photos are never sent to AI.
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
const PNG = [...Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")];
const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
const aiStatus = active => ({
  configured: true, active, plan: active ? "addon" : "none", percentUsed: 10, resetsAt: "2026-11-01T00:00:00.000Z", usedUp: false,
  carriedOverPercent: 0, nextLapseAt: null, nextLapsePercent: 0,
});
const READ = {
  "fire-call-points": { headers: ["Call point", "Location", "Site"], rows: [["CP1", "Reception", ""], ["CP2", "Kitchen", ""]] },
  "greentrack-equipment": { headers: ["name", "type", "make", "model", "serial_no", "reg_no", "year", "site", "notes"], rows: [["Greens mower 1", "ride-on", "Toro", "", "", "", "", "", ""]] },
};

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
      billingLocked: false, client: { id: 23, name: "Golf Club", slug: "golf", logoUrl: null, primaryColor: "#2F7C8C", active: true },
      services: ["pattrack", "roomtrack", "firetrack", "greentrack"],
    });
    if (url.pathname === "/api/sites") return json(route, [{ id: 4, name: "Clubhouse" }]);
    if (url.pathname === "/api/imports/sort-list") return json(route, { kind: "fire-call-points" });
    const reading = /^\/api\/imports\/list-reading\/([a-z-]+)(\/read)?$/.exec(url.pathname);
    if (reading && !reading[2]) return json(route, { available: true, monthlyLimit: 10, usedThisMonth: 1, ai: aiStatus(aiActive), sites: [{ id: 4, name: "Clubhouse" }] });
    if (reading) return json(route, { ...READ[reading[1]], unclear: 0, unclearRows: [] });
    const importing = /^\/api\/imports\/([a-z-]+)$/.exec(url.pathname);
    if (importing && method === "POST") {
      const rows = body.rows.map((row, index) => ({ row: index + 2, action: "create", label: row[0], reasons: [] }));
      return json(route, { preview: body.preview, committed: !body.preview, summary: { total: rows.length, create: rows.length, update: 0, skip: 0, error: 0 }, rows, ignoredHeaders: [] });
    }
    if (url.pathname === "/api/green-track/machines/import") return json(route, { imported: body.rows.length, skipped: [] });
    if (url.pathname === "/api/setup/state") return json(route, { assistRequest: null });
    if (url.pathname === "/api/setup/assist-request") return json(route, { requestedAt: "2026-10-30T09:00:00.000Z", requestedBy: "Owner", emailed: true });
    return json(route, {});
  });
  await page.goto(`${baseUrl}/tests/upload-lists-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("drop-upload-lists").waitFor();
  return { page, requests, pageErrors };
}

/** Drops files on the box the way the operating system would. `text` files are CSV; others are made from the PNG bytes. */
function drop(page, files) {
  return page.evaluate(({ files, bytes }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([file.text ?? new Uint8Array(bytes)], file.name, { type: file.type }));
    const target = document.querySelector('[data-testid="drop-upload-lists"]');
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { files, bytes: PNG });
}

const posts = (requests, path) => requests.filter(r => r.method === "POST" && r.path === path);
async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${what}`);
}
const note = (page, id) => page.getByTestId(`upload-list-note-${id}`).innerText();
const FILES = [
  { name: "list from office.csv", type: "text/csv", text: "Contact name,Company,Email,Phone\nSam Patel,Patel Electrical,sam@example.test,01234\n" },
  { name: "rooms.csv", type: "text/csv", text: "Room number,Floor\n101,1\n" },
  { name: "IMG_0042.png", type: "image/png" },
  { name: "machines.pdf", type: "application/pdf" },
  { name: "notes.csv", type: "text/csv", text: "Foo,Bar\n1,2\n" },
  { name: "Book1.csv", type: "text/csv", text: "Payroll ID,Name,Job Title,Department\n1001,Jane Roster,Chef,Kitchen\n" },
];

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });

  {
    // "Upload your lists" leads with the ALPS setup service (the upsell).
    const { page, requests, pageErrors } = await open(true);
    const offer = page.getByTestId("setup-service-offer");
    await offer.waitFor();
    assert.match(await offer.innerText(), /Let ALPS set it all up for you[\s\S]*£500 \+ VAT, added to your first payment/);
    await offer.getByRole("button", { name: "Ask ALPS to set it up for you" }).click();
    await page.getByLabel("Best phone number (optional)").fill("01563 000000");
    await offer.getByRole("button", { name: "Send request to ALPS" }).click();
    await offer.getByText(/Request sent on/).waitFor();
    assert.deepEqual(posts(requests, "/api/setup/assist-request").map(r => r.body), [{ phone: "01563 000000" }]);
    const accept = await page.getByTestId("input-upload-lists").getAttribute("accept");
    assert.ok(accept.includes("image/*") && accept.includes(".pdf") && accept.includes(".xlsx"));
    assert.equal(await page.getByTestId("input-upload-lists").getAttribute("multiple"), "");
    await drop(page, FILES);
    await waitFor(() => posts(requests, "/api/imports/sort-list").length === 1, "the photo to be sorted");
    await page.getByTestId("select-upload-list-kind-3").waitFor();
    assert.equal(await page.getByTestId("select-upload-list-kind-1").inputValue(), "contractors");
    assert.match(await note(page, 1), /1 row, sorted by its column headings/);
    assert.equal(await page.getByTestId("select-upload-list-kind-2").inputValue(), "room-track-rooms");
    assert.equal(await page.getByTestId("select-upload-list-kind-3").inputValue(), "fire-call-points");
    assert.match(await note(page, 3), /Sorted by AI/);
    assert.equal(posts(requests, "/api/imports/sort-list")[0].body.mimeType, "image/png");
    assert.equal(await page.getByTestId("select-upload-list-kind-4").inputValue(), "greentrack-equipment");
    assert.match(await note(page, 4), /Sorted by its file name/);
    assert.equal(posts(requests, "/api/imports/sort-list").length, 1, "a PDF named for its list is not sent to AI");
    assert.equal(await page.getByTestId("select-upload-list-kind-5").inputValue(), "");
    assert.ok(await page.getByTestId("button-upload-list-open-5").isDisabled(), "an unsorted file waits for the person to choose");
    await page.getByTestId("select-upload-list-kind-5").selectOption("contractors");
    assert.ok(await page.getByTestId("button-upload-list-open-5").isEnabled());
    const options = await page.getByTestId("select-upload-list-kind-5").locator("option").allInnerTexts();
    assert.ok(options.includes("Staff roster"));
    assert.equal(await page.getByTestId("select-upload-list-kind-6").inputValue(), "staff-roster");

    // The staff list opens in the roster upload with its people read.
    await page.getByTestId("button-upload-list-open-6").click();
    await page.getByRole("dialog").getByText("Jane Roster").first().waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Contractors: the import dialog opens with the spreadsheet already previewed.
    await page.getByTestId("button-upload-list-open-1").click();
    await waitFor(() => posts(requests, "/api/imports/contractors").length === 1, "the contractors preview");
    assert.deepEqual(posts(requests, "/api/imports/contractors")[0].body.headers, ["Contact name", "Company", "Email", "Phone"]);
    await page.getByTestId("button-confirm-contractors-import").click();
    await page.getByTestId("upload-list-1").getByText("Contractors").waitFor();
    assert.equal(await page.getByTestId("select-upload-list-kind-1").count(), 0, "an imported file is marked done");

    // The photo: the call points import reads it with AI, then previews it.
    await page.getByTestId("button-upload-list-open-3").click();
    await waitFor(() => posts(requests, "/api/imports/fire-call-points").length === 1, "the call points preview");
    assert.equal(posts(requests, "/api/imports/list-reading/fire-call-points/read").length, 1);
    await page.getByRole("button", { name: "Cancel" }).click();

    // The PDF: the GreenTrack equipment import reads it.
    await page.getByTestId("button-upload-list-open-4").click();
    await waitFor(() => posts(requests, "/api/imports/list-reading/greentrack-equipment/read").length === 1, "the machines to be read");
    await page.getByTestId("list-read-note-greentrack-equipment").waitFor();
    assert.deepEqual(pageErrors, []);
    await page.close();
  }

  {
    const { page, requests, pageErrors } = await open(false);
    const accept = await page.getByTestId("input-upload-lists").getAttribute("accept");
    assert.ok(!accept.includes("image") && !accept.includes(".pdf"), "only spreadsheets can be chosen without AI");
    await page.getByTestId("upload-lists-ai-note").waitFor();
    await drop(page, [FILES[2]]);
    await page.getByTestId("select-upload-list-kind-1").waitFor();
    assert.match(await note(page, 1), /AI features add-on/);
    assert.equal(posts(requests, "/api/imports/sort-list").length, 0, "nothing is sent to AI without the add-on");
    assert.deepEqual(pageErrors, []);
  }
  console.log("Upload your lists browser checks passed: sorting by headings, AI and file name, choosing, and opening each import with its file.");
} catch (error) {
  console.error("Upload your lists:", browser ? await browser.contexts().at(-1)?.pages().at(-1)?.locator("body").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
