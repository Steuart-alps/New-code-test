import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for "Add" buttons that add a row to a list
// (src/hooks/use-focus-new-row.ts, src/components/string-list-editor.tsx):
//   - the cursor goes into the new row's first empty box, no click needed,
//   - typing in a names list keeps the cursor (it used to drop after each letter),
//   - on phones only typing boxes take the cursor, so a date wheel or
//     drop-down never opens by itself,
//   - an add that was refused does not let a later reload move the cursor.
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

const focused = page => page.evaluate(() => {
  const el = document.activeElement;
  return el?.getAttribute("aria-label") ?? el?.getAttribute("placeholder") ?? el?.textContent?.trim() ?? el?.tagName;
});

async function open(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseUrl}/tests/focus-new-row-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("names").waitFor();
  return { page, errors };
}

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });

  // Computer.
  {
    const { page, errors } = await open({ viewport: { width: 1280, height: 900 } });
    const names = page.getByTestId("names");
    await names.getByRole("button", { name: "Add" }).click();
    const newName = names.getByPlaceholder("Location").nth(1);
    assert.ok(await newName.evaluate(el => el === document.activeElement), "Add puts the cursor in the new name box");
    await page.keyboard.type("Bar");
    assert.equal(await newName.inputValue(), "Bar", "typing goes straight into the new row");
    assert.ok(await newName.evaluate(el => el === document.activeElement), "the box keeps the cursor while typing");

    await page.getByRole("button", { name: "Add freezer" }).click();
    assert.equal(await focused(page), "Unit 2 name", "a filled-in drop-down is skipped for the first empty box");

    await page.getByRole("button", { name: "Add product" }).click();
    assert.equal(await focused(page), "Row 2 product", "on a computer an empty drop-down takes the cursor");

    await page.getByRole("button", { name: "Add full row" }).click();
    assert.equal(await focused(page), "Add full row", "a refused add leaves the cursor alone");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Reload list" }).click();
    assert.equal(await focused(page), "Reload list", "rows that appear later do not take the cursor");
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // Phone.
  {
    const { page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.getByTestId("names").getByRole("button", { name: "Add" }).tap();
    assert.equal(await focused(page), "Location", "on a phone the new name box takes the cursor (keyboard is wanted)");
    await page.getByRole("button", { name: "Add freezer" }).tap();
    assert.equal(await focused(page), "Unit 2 name");
    await page.getByRole("button", { name: "Add product" }).tap();
    assert.notEqual(await focused(page), "Row 2 product", "on a phone a drop-down does not open by itself");
    assert.notEqual(await focused(page), "Row 2 date", "on a phone a date picker does not open by itself");
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  console.log("New-row cursor checks passed: new rows take the cursor, typing keeps it, phones skip pickers, refused adds and reloads leave it alone.");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
