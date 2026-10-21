// Home page module cards: every card has the same layout and opens the pricing
// builder with its module ticked, and every picked module shows in green. There used to be a fourth row of plainer,
// unclickable legislation tiles under the cards.
// Run: pnpm --filter @workspace/compliance-tracker run test:landing-modules-browser
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  for (let attempt = 0; attempt < 200; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}

const MODULE_KEYS = [
  "core", "firetrack", "kitchentrack", "legionellatrack", "fixtrack", "safetrack",
  "premisestrack", "traintrack", "hottubtrack", "treetrack", "pattrack", "pesttrack", "coshhtrack",
];

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  await page.goto(`${baseUrl}/tests/landing-modules-harness.html`);
  await page.getByText("One platform, every compliance discipline").waitFor();

  // One grid, one card per module, each a link to the pricing builder.
  const grid = page.getByTestId("module-card-core").locator("xpath=..");
  const children = await grid.evaluate(el => Array.from(el.children).map(child => ({
    testId: child.getAttribute("data-testid"),
    tag: child.tagName,
    href: child.getAttribute("href"),
    className: child.className,
  })));
  assert.deepEqual(children.map(c => c.testId), MODULE_KEYS.map(k => `module-card-${k}`),
    "the module grid holds exactly one card per module");
  for (const child of children) {
    assert.equal(child.tag, "A", `${child.testId} is a link`);
    assert.equal(child.href, "#pricing", `${child.testId} links to the pricing builder`);
    assert.equal(child.className, children[0].className, `${child.testId} has the same layout as the other cards`);
  }

  // The legislation lines sit inside their own module card, not in a separate row.
  for (const [key, text] of [
    ["firetrack", "Regulatory Reform (Fire Safety) Order 2005"],
    ["kitchentrack", "Food Safety Act 1990"],
    ["legionellatrack", "HSG274 / L8 ACOP"],
    ["premisestrack", "Workplace (Health, Safety and Welfare) Regulations 1992"],
  ]) {
    assert.equal(await page.getByText(text).count(), 1, `"${text}" appears once`);
    assert.equal(await page.getByTestId(`module-card-${key}`).getByText(text).count(), 1, `"${text}" is on the ${key} card`);
  }

  const summary = page.getByText(/modules? selected · 14-day free trial/);
  assert.match(await summary.textContent(), /^1 module selected/);

  await page.getByTestId("module-card-treetrack").click();
  assert.equal(new URL(page.url()).hash, "#pricing", "clicking a card goes to the pricing builder");
  assert.match(await summary.textContent(), /^2 modules selected/, "clicking a card ticks its module");
  await page.waitForFunction(() => {
    const rect = document.getElementById("pricing").getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  });

  // Clicking the same card again, or Core, never unticks anything.
  await page.getByTestId("module-card-treetrack").click();
  await page.getByTestId("module-card-core").click();
  assert.match(await summary.textContent(), /^2 modules selected/);

  await page.getByTestId("module-card-firetrack").click();
  assert.match(await summary.textContent(), /^3 modules selected/);

  // Every picked module shows the same green, whatever its own colour: a red
  // or orange border on a chosen module reads as a fault.
  await page.getByTestId("plan-module-pattrack").click();
  await page.getByTestId("plan-module-kitchentrack").click();
  await page.waitForTimeout(400); // the cards' 200ms colour transition
  const planCards = await page.locator("[data-testid^=plan-module-]").evaluateAll(cards => cards.map(card => ({
    key: card.dataset.testid.replace("plan-module-", ""),
    selected: card.dataset.selected === "true",
    border: getComputedStyle(card).borderTopColor,
  })));
  const picked = planCards.filter(card => card.selected);
  assert.deepEqual(picked.map(card => card.key).sort(), ["core", "firetrack", "kitchentrack", "pattrack", "treetrack"]);
  assert.equal(new Set(picked.map(card => card.border)).size, 1, `picked modules share one border colour: ${JSON.stringify(picked)}`);
  const pickedBorder = picked[0].border;
  const greenProbe = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "border-2 border-green-600";
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return colour;
  });
  assert.equal(pickedBorder, greenProbe, "picked modules are outlined in green");
  for (const card of planCards.filter(card => !card.selected)) {
    assert.notEqual(card.border, pickedBorder, `${card.key} is not picked and is not green`);
  }
  await page.getByTestId("plan-module-pattrack").click();
  await page.getByTestId("plan-module-kitchentrack").click();

  await page.locator("#pricing").getByRole("button", { name: /Start free trial/ }).click();
  await page.waitForFunction(() => window.location.pathname === "/signup");
  const modules = new URL(page.url()).searchParams.get("modules")?.split(",").sort();
  assert.deepEqual(modules, ["firetrack", "treetrack"], "the chosen modules carry through to sign-up");

  assert.deepEqual(pageErrors, []);
  console.log("ok - home page module cards share one layout and add their module to the plan");
} finally {
  await browser?.close();
  vite.kill();
}
