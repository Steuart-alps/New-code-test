import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, firefox, webkit } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
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
  createdAt: "2026-09-23T00:00:00.000Z",
};
const inactiveTub = {
  id: 702,
  clientId: 42,
  siteId: 11,
  siteName: "Main site",
  name: "Inactive browser tub",
  description: null,
  active: false,
  createdAt: "2026-09-23T00:00:00.000Z",
};

const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test", REPL_ID: undefined },
  stdio: ["ignore", "ignore", "ignore"],
});
let browser;
let page;

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

try {
  await waitForServer();
  browser = await browserType.launch({
    headless: true,
    executablePath: browserExecutablePath,
  });
  page = await browser.newPage();
  page.on("console", message => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", error => console.error(`[browser:error] ${error.message}`));
  const tubRequests = [];

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
      return jsonResponse(route, [{ id: 11, name: "Main site" }]);
    }
    if (pathname === "/hot-tub/tubs" || pathname === "/api/hot-tub/tubs") {
      tubRequests.push(url.toString());
      const active = searchParams.get("active");
      const tubs = active === "true"
        ? [activeTub]
        : active === "false"
          ? [inactiveTub]
          : [activeTub, inactiveTub];
      return jsonResponse(route, tubs);
    }
    if (isHotTubApiRequest) {
      return jsonResponse(route, []);
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
    return route.continue();
  });

  const navigation = await page.goto(`${baseUrl}/hot-tub`);
  if (!navigation?.ok()) {
    throw new Error(`HotTub browser navigation failed: ${navigation?.status() ?? "no response"}`);
  }
  await page.getByRole("button", { name: "Manage Tubs" }).click();
  const dialog = page.getByRole("dialog");
  const activeTubRow = dialog.getByText(activeTub.name, { exact: true });
  const inactiveTubRow = dialog.getByText(inactiveTub.name, { exact: true });
  await activeTubRow.waitFor({ state: "visible" });
  await inactiveTubRow.waitFor({ state: "visible" });

  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "Inactive tubs" }).click();
  await inactiveTubRow.waitFor({ state: "visible" });
  await activeTubRow.waitFor({ state: "hidden" });
  assert.ok(tubRequests.some(url => url.includes("active=false")), "inactive selection should request inactive assets");

  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Manage Tubs" }).click();
  const reopenedDialog = page.getByRole("dialog");
  await reopenedDialog.getByRole("combobox").getByText("Inactive tubs").waitFor({ state: "visible" });
  await reopenedDialog.getByText(inactiveTub.name, { exact: true }).waitFor({ state: "visible" });
  await reopenedDialog.getByText(activeTub.name, { exact: true }).waitFor({ state: "hidden" });

  console.log(`HotTub activity filter ${browserName} browser checks passed.`);
} catch (error) {
  if (/Executable doesn't exist|browserType\.launch:.*executable/i.test(String(error))) {
    console.log(`HotTub activity filter ${browserName} browser check skipped: browser binary is unavailable.`);
  } else {
    if (page) {
      console.error("HotTub browser URL at failure:", page.url());
      console.error("HotTub browser HTML at failure:", (await page.content()).slice(0, 4000));
    }
    throw error;
  }
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}