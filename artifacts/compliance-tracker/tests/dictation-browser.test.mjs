import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for voice dictation (src/components/dictation-button.tsx,
// src/components/ui/textarea.tsx, src/components/coshh-speak-list-dialog.tsx).
// The browser's speech recognition is replaced by a fake the test speaks into.
//   - every notes box gets a microphone button; disabled boxes and boxes that
//     opt out do not; one-line boxes only when asked (dictation prop);
//   - spoken words reach both React-state boxes and react-hook-form boxes,
//     with spoken punctuation, capitals and the box's length limit;
//   - only one microphone listens at a time; blocked microphones explain why;
//   - browsers without speech recognition show no microphone buttons;
//   - "Speak a list" splits a spoken list into products, leaves out ones
//     already on the register, and keeps any that failed to add;
//   - "Say machine" listens as soon as it opens, picks a machine said by name
//     ("fairway mower one"), offers the choices to tap when two could fit,
//     and works at phone width.
// DICTATION_SCREENSHOTS=<dir> saves screenshots.
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
const screenshotDir = process.env.DICTATION_SCREENSHOTS;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const shot = async (page, name) => { if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png` }); };

// Stands in for Chrome's webkitSpeechRecognition. window.__speak(text, final)
// delivers a result to the listening recogniser; window.__fail(error) fails it.
function installFakeRecognition() {
  window.__recognisers = [];
  class FakeRecognition {
    constructor() { this.lang = ""; this.continuous = false; this.interimResults = false; this.active = false; this.results = []; window.__recognisers.push(this); }
    start() { if (this.active) throw new Error("already started"); this.active = true; }
    stop() { if (!this.active) return; this.active = false; setTimeout(() => this.onend?.(), 0); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const listening = () => window.__recognisers.filter(r => r.active);
  window.__listeningCount = () => listening().length;
  window.__lastLang = () => window.__recognisers.at(-1)?.lang;
  window.__speak = (text, final = true) => {
    const recogniser = listening().at(-1);
    if (!recogniser) throw new Error("nothing is listening");
    // Interim results are replaced by the next result at the same index.
    if (recogniser.results.length && !recogniser.results.at(-1).isFinal) recogniser.results.pop();
    const result = Object.assign([{ transcript: text }], { isFinal: final });
    recogniser.results.push(result);
    recogniser.onresult?.({ resultIndex: recogniser.results.length - 1, results: recogniser.results });
  };
  window.__fail = error => {
    const recogniser = listening().at(-1);
    recogniser.onerror?.({ error });
    recogniser.stop();
  };
}

const micFor = (page, id) => page.locator(`#${id}`).locator("xpath=..").locator("[data-slot='dictation-button']");
const valueOf = (page, id) => page.locator(`#${id}`).inputValue();
const speak = (page, text, final = true) => page.evaluate(([t, f]) => window.__speak(t, f), [text, final]);
const IDLE_LABEL = "Dictate (speak instead of typing)";
// The button goes back to idle when the recogniser reports it has ended,
// which happens just after it stops listening, so wait for it.
async function waitForIdleMic(page, id, message) {
  await page.waitForFunction(([boxId, label]) =>
    document.getElementById(boxId)?.parentElement?.querySelector("[data-slot='dictation-button']")?.getAttribute("aria-label") === label,
  [id, IDLE_LABEL], { timeout: 5000 }).catch(() => assert.fail(message));
}
const listeningCount = page => page.evaluate(() => window.__listeningCount());

// The list dialog's site picker loads the sites.
async function routeApi(context) {
  await context.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/sites") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
        { id: 1, name: "Harbour Hotel" }, { id: 2, name: "Lakeside Lodge" },
      ]) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not in the dictation fixture" }) });
  });
}

async function checkSupported() {
  const context = await browser.newContext({ locale: "en-GB" });
  await routeApi(context);
  await context.addInitScript(installFakeRecognition);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/tests/dictation-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Open list" }).waitFor();

  // Which boxes have a microphone.
  assert.equal(await micFor(page, "state-notes").count(), 1, "notes box has a microphone");
  assert.equal(await micFor(page, "form-notes").count(), 1, "form notes box has a microphone");
  assert.equal(await micFor(page, "product").count(), 1, "one-line box that asks for it has a microphone");
  assert.equal(await micFor(page, "locked").count(), 0, "disabled box has no microphone");
  assert.equal(await page.locator("#plain").locator("xpath=..").locator("[data-slot='dictation-button']").count(), 0,
    "box that opts out has no microphone");

  // React-state box: words go where the cursor is, with punctuation and capitals.
  await page.locator("#state-notes").click();
  await page.locator("#state-notes").press("End");
  const stateMic = micFor(page, "state-notes");
  await stateMic.click();
  assert.equal(await stateMic.getAttribute("aria-label"), "Stop dictating");
  assert.equal(await page.evaluate(() => window.__lastLang()), "en-GB");
  await speak(page, "fire doors", false);
  await page.getByText("fire doors", { exact: true }).waitFor();
  await shot(page, "1-listening");
  await speak(page, "fire doors checked full stop all fine");
  assert.equal(await valueOf(page, "state-notes"), "Existing note fire doors checked. All fine");
  assert.equal(await page.getByTestId("state-value").textContent(), "Existing note fire doors checked. All fine",
    "React state sees the dictated words");
  // The length limit holds.
  await speak(page, "and the emergency lighting was tested as well today");
  assert.equal((await valueOf(page, "state-notes")).length, 80);
  await stateMic.click();
  await page.waitForFunction(() => window.__listeningCount() === 0);
  await waitForIdleMic(page, "state-notes", "stopping returns the button to idle");

  // react-hook-form box: the value is saved with the form.
  const formMic = micFor(page, "form-notes");
  await formMic.click();
  await speak(page, "boiler pressure low");
  await formMic.click();
  await page.getByRole("button", { name: "Save form" }).click();
  await page.getByTestId("form-value").filter({ hasText: "Boiler pressure low" }).waitFor();

  // Only one microphone at a time.
  await stateMic.click();
  await micFor(page, "product").click();
  await page.waitForFunction(() => window.__listeningCount() === 1);
  await waitForIdleMic(page, "state-notes", "starting another microphone stops the first");
  await speak(page, "oven cleaner");
  assert.equal(await valueOf(page, "product"), "Oven cleaner");

  // A blocked microphone explains what to do.
  await page.evaluate(() => window.__fail("not-allowed"));
  await page.getByText("Allow the microphone for this site", { exact: false }).waitFor();
  await waitForIdleMic(page, "product", "a failed microphone returns to idle");

  // Speak a list.
  await page.getByRole("button", { name: "Open list" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a list of substances" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Start speaking" }).click();
  await speak(page, "thick bleach");
  await speak(page, "oven cleaner and Milton sterilising fluid");
  await dialog.getByRole("button", { name: "Stop listening" }).click();
  await page.waitForFunction(() => window.__listeningCount() === 0);
  assert.equal(await dialog.locator("#coshh-list-text").inputValue(), "thick bleach\noven cleaner and Milton sterilising fluid");
  await dialog.getByText("Already on the register").waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 3);
  assert.equal(await dialog.getByRole("checkbox", { checked: true }).count(), 2, "the repeat starts unticked");
  await shot(page, "2-speak-a-list");
  await dialog.getByRole("button", { name: "Add 2 substances" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__added), [{ siteId: 1, names: ["Oven cleaner", "Milton sterilising fluid"] }]);

  // A product that failed to add stays in the dialog to try again.
  await page.getByRole("button", { name: "Open list" }).click();
  await dialog.waitFor();
  assert.equal(await dialog.locator("#coshh-list-text").inputValue(), "", "the dialog opens empty");
  await dialog.locator("#coshh-list-text").fill("Fail one, Descaler");
  await dialog.getByRole("button", { name: "Add 2 substances" }).click();
  await dialog.getByRole("button", { name: "Add 1 substance" }).waitFor();
  assert.equal(await dialog.locator("#coshh-list-text").inputValue(), "Fail one");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });

  // Say machine: one clear match is picked straight away.
  const pick = page.getByRole("dialog", { name: "Say the machine" });
  await page.getByRole("button", { name: "Say machine" }).click();
  await pick.waitFor();
  await page.waitForFunction(() => window.__listeningCount() === 1).catch(() => assert.fail("opening the dialog starts listening"));
  await speak(page, "fairway mower", false);
  await pick.getByText("fairway mower", { exact: true }).waitFor();
  await speak(page, "fairway mower one");
  await pick.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__picked), ["Fairway Mower 1"]);
  await page.waitForFunction(() => window.__listeningCount() === 0).catch(() => assert.fail("picking stops listening"));

  // Two could fit: both are offered to tap.
  await page.getByRole("button", { name: "Say machine" }).click();
  await pick.waitFor();
  await page.waitForFunction(() => window.__listeningCount() === 1);
  await speak(page, "the fairway mower");
  await pick.getByText("Which machine did you mean?", { exact: false }).waitFor();
  assert.deepEqual(await pick.getByTestId("list-speak-to-pick-choices").getByRole("button").allTextContents(),
    ["Fairway Mower 1", "Fairway Mower 2"]);
  await shot(page, "3-say-machine-choices");
  await pick.getByRole("button", { name: "Fairway Mower 2" }).click();
  await pick.waitFor({ state: "detached" });

  // Nothing fits: say so; typing the name works too.
  await page.getByRole("button", { name: "Say machine" }).click();
  await pick.waitFor();
  await page.waitForFunction(() => window.__listeningCount() === 1);
  await speak(page, "greens mower three");
  await pick.getByText("No machine matches that", { exact: false }).waitFor();
  // Still listening, so the name can simply be said again.
  assert.equal(await listeningCount(page), 1);
  await pick.getByLabel("Or type the name").fill("tees");
  await pick.getByLabel("Or type the name").press("Enter");
  await pick.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__picked), ["Fairway Mower 1", "Fairway Mower 2", "Tees Mower"]);

  assert.deepEqual(pageErrors, []);
  await context.close();
}

// Say machine on a phone: the dialog fits the screen and the buttons are big enough to tap.
async function checkPhone() {
  const context = await browser.newContext({ locale: "en-GB", viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36" });
  await routeApi(context);
  await context.addInitScript(installFakeRecognition);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/tests/dictation-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Say machine" }).tap();
  const pick = page.getByRole("dialog", { name: "Say the machine" });
  await pick.waitFor();
  await page.waitForFunction(() => window.__listeningCount() === 1);
  await speak(page, "fairway mower");
  const choice = pick.getByRole("button", { name: "Fairway Mower 1" });
  await choice.waitFor();
  // Measured once the opening zoom has finished.
  await page.waitForFunction(() => {
    const rect = document.querySelector("[data-testid='speak-to-pick-dialog']")?.getBoundingClientRect();
    return rect && rect.left >= 0 && rect.right <= window.innerWidth;
  }, null, { timeout: 5000 }).catch(() => assert.fail("the dialog fits a phone screen"));
  assert.ok((await choice.boundingBox()).height >= 40, "choices are big enough to tap");
  await shot(page, "4-say-machine-phone");
  // Android listens to one phrase per tap, so "Try again" listens again.
  await page.evaluate(() => window.__recognisers.at(-1).stop());
  await pick.getByRole("button", { name: "Try again" }).tap();
  await page.waitForFunction(() => window.__listeningCount() === 1);
  await speak(page, "fairway mower number two");
  await pick.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__picked), ["Fairway Mower 2"]);
  await context.close();
}

async function checkUnsupported() {
  const context = await browser.newContext();
  await routeApi(context);
  await context.addInitScript(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/tests/dictation-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Open list" }).waitFor();
  assert.equal(await page.locator("[data-slot='dictation-button']").count(), 0, "no microphones without speech recognition");
  assert.equal(await page.locator("[data-slot='dictation-field']").count(), 0, "boxes are not wrapped");
  await page.getByRole("button", { name: "Open list" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a list of substances" });
  await dialog.getByText("Type the product names", { exact: false }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start speaking" }).count(), 0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // Say machine still lets the name be typed.
  await page.getByRole("button", { name: "Say machine" }).click();
  const pick = page.getByRole("dialog", { name: "Say the machine" });
  await pick.getByText("Type the machine's name.").waitFor();
  assert.equal(await pick.getByTestId("button-speak-to-pick-mic").count(), 0);
  await context.close();
}

try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: chromiumPath() });
  await checkSupported();
  await checkPhone();
  await checkUnsupported();
  console.log("Dictation browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
