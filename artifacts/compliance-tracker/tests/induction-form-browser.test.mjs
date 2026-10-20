import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

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

// Browser regression for the SafeTrack induction form (InductionForm in
// src/pages/safe-track.tsx). Several edits can land before React re-renders
// (fast clicks, browser autofill, a slow device); each must build on the
// previous one rather than on the checklist the last render saw, or earlier
// answers are silently dropped from the saved and printed induction record.

const checks = [];
const pageErrors = [];
const formState = page => page.evaluate(() => {
  const form = JSON.parse(document.querySelector("[data-testid='form-state']").textContent);
  return { ...form, checklist: form.checklist ? JSON.parse(form.checklist) : null };
});

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1400 }, locale: "en-GB" });
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/tests/induction-form-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Full name").waitFor({ timeout: 60_000 });

  // All of these fire in one browser task, before React gets to re-render.
  await page.evaluate(() => {
    const sections = [...document.querySelectorAll(".divide-y > div")];
    const button = (index, label) => [...sections[index].querySelectorAll("button")].find(b => b.textContent === label);
    const type = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const labelled = label => [...document.querySelectorAll("label")].find(l => l.textContent === label).parentElement.querySelector("input");
    button(0, "Yes").click();
    button(1, "No").click();
    button(2, "N/A").click();
    type(sections[3].querySelector("input"), "Shown the fire exits");
    type(sections[4].querySelector("input"), "Gloves issued");
    type(labelled("Job Title"), "Chef de partie");
    type(labelled("Department"), "Kitchen");
    type(document.querySelector("input[placeholder='Full name']"), "Jamie O'Neill");
    button(5, "Yes").click();
  });
  await page.waitForTimeout(100);
  let state = await formState(page);
  assert.equal(state.staffName, "Jamie O'Neill");
  assert.equal(state.checklist.jobTitle, "Chef de partie");
  assert.equal(state.checklist.department, "Kitchen");
  assert.deepEqual(state.checklist.items.slice(0, 6).map(item => [item.status, item.comments]), [
    ["yes", ""], ["no", ""], ["na", ""], ["", "Shown the fire exits"], ["", "Gloves issued"], ["yes", ""],
  ]);
  checks.push("back-to-back status, comment, job title, department and name edits are all kept");

  // Toggling the same answer twice in one task clears it, as two clicks should.
  await page.evaluate(() => {
    const yes = [...document.querySelectorAll(".divide-y > div")[0].querySelectorAll("button")].find(b => b.textContent === "Yes");
    yes.click();
    yes.click();
  });
  await page.waitForTimeout(100);
  state = await formState(page);
  assert.equal(state.checklist.items[0].status, "yes", "clear then set again");
  assert.equal(state.checklist.items[1].status, "no", "other sections untouched");
  checks.push("two quick clicks on one answer toggle from the latest value");

  assert.deepEqual(pageErrors, []);
  console.log(`Induction form browser checks passed (${checks.length}/${checks.length}):\n${checks.map(c => `  ✓ ${c}`).join("\n")}`);
} catch (error) {
  console.error("Induction form state:", browser ? await browser.contexts()[0]?.pages()[0]?.locator("[data-testid='form-state']").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
