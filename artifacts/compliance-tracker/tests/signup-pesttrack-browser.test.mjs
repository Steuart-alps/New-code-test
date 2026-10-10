import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// The signup dropdown must offer exactly the business types the register API accepts.
const authSource = await readFile(new URL("../../api-server/src/routes/auth.ts", import.meta.url), "utf8");
const apiBusinessTypesSource = authSource.match(/const BUSINESS_TYPES = \[([\s\S]*?)\] as const;/);
assert.ok(apiBusinessTypesSource, "the register API should define BUSINESS_TYPES");
const apiBusinessTypes = [...apiBusinessTypesSource[1].matchAll(/"([^"]+)"/g)].map(([, value]) => value);

const RECOMMENDED = [
  "hotel_accommodation",
  "restaurant_cafe_pub",
  "care_home_healthcare",
  "holiday_park_campsite",
];
const NOT_RECOMMENDED = [
  "leisure_sports_centre",
  "nursery_school",
  "offices_commercial",
  "retail",
  "pest_control",
  "other",
];
assert.deepEqual(
  [...RECOMMENDED, ...NOT_RECOMMENDED].sort(),
  [...apiBusinessTypes].sort(),
  "every API business type should be classified as recommended or not recommended for PestTrack",
);

const RECOMMENDATION_TITLE = "PestTrack is recommended for your business";
const INCLUDED_MESSAGE = "It is included in your selected plan, ready to use after signup.";
const ACTIVATE_MESSAGE = "You can activate it from module settings after signup.";

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
  for (let attempt = 0; attempt < 200; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}

try {
  await waitForVite();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => console.error(`[browser:error] ${error.message}`));
  // Signed out: the signup page is public and must not depend on any API response.
  await page.route("**/api/**", route => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "Not authenticated" }),
  }));

  const businessType = page.locator("#business-type");
  const recommendation = page.getByText(RECOMMENDATION_TITLE, { exact: true });

  const waitOrFail = async (locator, state, message) => {
    try {
      await locator.waitFor({ state, timeout: 5000 });
    } catch {
      assert.fail(message);
    }
  };

  const openSignup = async query => {
    const response = await page.goto(`${baseUrl}/signup${query}`, { waitUntil: "domcontentloaded" });
    assert.ok(response?.ok(), `Signup navigation failed: ${response?.status()}`);
    await businessType.waitFor({ state: "visible" });
  };
  const expectRecommendation = async (type, message, context) => {
    await businessType.selectOption(type);
    await waitOrFail(recommendation, "visible", `${type} (${context}) should show the PestTrack recommendation`);
    await waitOrFail(page.getByText(message), "visible", `${type} (${context}) should show "${message}"`);
    const otherMessage = message === INCLUDED_MESSAGE ? ACTIVATE_MESSAGE : INCLUDED_MESSAGE;
    assert.equal(
      await page.getByText(otherMessage).count(),
      0,
      `${type} (${context}) should not show "${otherMessage}"`,
    );
  };
  const expectNoRecommendation = async type => {
    await businessType.selectOption(type);
    assert.equal(await businessType.inputValue(), type);
    await waitOrFail(recommendation, "detached", `${type || "no business type"} should not show the PestTrack recommendation`);
  };

  await openSignup("");
  const optionValues = await businessType.locator("option").evaluateAll(
    options => options.map(option => option.value).filter(Boolean),
  );
  assert.deepEqual(optionValues.sort(), [...apiBusinessTypes].sort(), "signup business types should match the register API");
  assert.equal(await recommendation.count(), 0, "no recommendation before a business type is chosen");

  // No plan chosen: relevant businesses are told to activate PestTrack after signup.
  for (const type of RECOMMENDED) {
    await expectRecommendation(type, ACTIVATE_MESSAGE, "no plan");
  }
  for (const type of NOT_RECOMMENDED) {
    await expectNoRecommendation(type);
  }
  await expectRecommendation("hotel_accommodation", ACTIVATE_MESSAGE, "no plan");
  await expectNoRecommendation("");

  // A plan without PestTrack still points to activating it after signup.
  await openSignup("?modules=fixtrack,safetrack");
  for (const type of RECOMMENDED) {
    await expectRecommendation(type, ACTIVATE_MESSAGE, "plan without PestTrack");
  }

  // PestTrack chosen as a module, or the full bundle: it is already included.
  for (const query of ["?modules=pesttrack", "?modules=fixtrack,pesttrack", "?bundle=true"]) {
    await openSignup(query);
    for (const type of RECOMMENDED) {
      await expectRecommendation(type, INCLUDED_MESSAGE, query);
    }
    for (const type of NOT_RECOMMENDED) {
      await expectNoRecommendation(type);
    }
  }

  console.log("Signup PestTrack recommendation browser tests passed.");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
