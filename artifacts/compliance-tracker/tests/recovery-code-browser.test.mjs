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

const jsonResponse = (route, data, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(data),
});

let recoveryCodesRemaining = 10;
let meRequestCount = 0;
let currentRole = "client_admin";
let billingLocked = false;
let currentUserId = 156;
let countResponseUserIdOverride = null;
let meRequestsSinceNavigation = 0;
let delayMeRequestNumber = null;
let delayCountQueryOnNextNavigation = false;
let delayNextMeRequest = false;
let delayedMeResponseStarted = false;
let delaySuccessfulRegeneration = false;
let delayedRegenerationStarted = false;
let releaseDelayedRegeneration = null;
let regenerationRequestCount = 0;
let csrfTokenRequestCount = 0;
const regenerationCsrfHeaders = [];
const issuedCodes = Array.from({ length: 10 }, (_, index) => `SYNTHETIC-CODE-${String(index + 1).padStart(2, "0")}`);

try {
  await waitForVite();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  const page = await browser.newPage();
  await page.clock.install();
  page.setDefaultTimeout(15000);
  page.on("console", message => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", error => console.error(`[browser:error] ${error.message}`));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/csrf-token") {
      csrfTokenRequestCount += 1;
      return jsonResponse(route, { token: "browser-test-csrf" });
    }
    if (url.pathname === "/api/auth/me") {
      meRequestCount += 1;
      meRequestsSinceNavigation += 1;
      const responseData = {
        user: {
          id: countResponseUserIdOverride ?? currentUserId,
          email: "recovery-codes@example.test",
          name: "Recovery Codes Browser Test",
          role: currentRole,
          clientId: 23,
          departmentId: null,
          active: true,
          totpEnabled: true,
          recoveryCodesRemaining,
        },
        billingLocked,
        client: {
          id: 23,
          name: "Recovery Code Test Client",
          slug: "recovery-code-test-client",
          logoUrl: null,
          primaryColor: "#2F7C8C",
          active: true,
        },
        services: [],
      };
      if (delayMeRequestNumber === meRequestsSinceNavigation) {
        delayMeRequestNumber = null;
        delayedMeResponseStarted = true;
        await new Promise(resolve => setTimeout(resolve, 900));
      } else if (delayNextMeRequest) {
        delayNextMeRequest = false;
        delayedMeResponseStarted = true;
        await new Promise(resolve => setTimeout(resolve, 900));
      }
      return jsonResponse(route, responseData);
    }
    if (url.pathname === "/api/auth/2fa/recovery-codes/regenerate") {
      const csrfHeader = route.request().headers()["x-csrf-token"] ?? null;
      regenerationCsrfHeaders.push(csrfHeader);
      if (csrfHeader !== "browser-test-csrf") {
        return jsonResponse(route, { error: "Missing or invalid CSRF token" }, 403);
      }
      regenerationRequestCount += 1;
      const { password } = route.request().postDataJSON();
      if (password !== "correct-password") {
        return jsonResponse(route, { error: "Incorrect password" }, 401);
      }
      if (delaySuccessfulRegeneration) {
        delaySuccessfulRegeneration = false;
        delayedRegenerationStarted = true;
        await new Promise(resolve => { releaseDelayedRegeneration = resolve; });
      }
      recoveryCodesRemaining = 10;
      return jsonResponse(route, { recoveryCodes: issuedCodes });
    }
    return jsonResponse(route, {});
  });

  const navigate = async () => {
    meRequestsSinceNavigation = 0;
    if (delayCountQueryOnNextNavigation) {
      delayMeRequestNumber = 2;
      delayCountQueryOnNextNavigation = false;
    }
    const response = await page.goto(`${baseUrl}/tests/recovery-code-harness.html`, { waitUntil: "domcontentloaded" });
    assert.ok(response?.ok(), `Harness navigation failed: ${response?.status()}`);
  };
  const warning = page.getByTestId("status-recovery-code-warning");
  const passwordInput = page.getByTestId("input-recovery-code-password");
  const waitForCount = async text => {
    await page.getByTestId("text-recovery-code-count").getByText(text, { exact: true }).waitFor({ state: "visible" });
  };
  const waitForCondition = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };

  delayCountQueryOnNextNavigation = true;
  await navigate();
  await page.getByTestId("status-recovery-code-count-loading").waitFor({ state: "visible" });
  await waitForCount("10 unused recovery codes remaining.");
  await warning.waitFor({ state: "detached" });

  recoveryCodesRemaining = 15;
  const requestsBeforeFirstPoll = meRequestCount;
  await page.clock.fastForward(30_000);
  await waitForCount("15 unused recovery codes remaining.");
  assert.ok(meRequestCount > requestsBeforeFirstPoll, "the 30-second polling interval should refresh the count");
  await warning.waitFor({ state: "detached" });

  recoveryCodesRemaining = 20;
  await navigate();
  await waitForCount("20 unused recovery codes remaining.");
  await warning.waitFor({ state: "detached" });

  recoveryCodesRemaining = 1;
  await navigate();
  await waitForCount("1 unused recovery code remaining.");
  await warning.getByText("Only 1 unused recovery code remains. Generate a new set soon.").waitFor({ state: "visible" });

  recoveryCodesRemaining = 3;
  await navigate();
  await waitForCount("3 unused recovery codes remaining.");
  await page.getByTestId("button-regenerate-recovery-codes-warning").click();
  await passwordInput.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "input-recovery-code-password");
  await passwordInput.fill("draft-password");

  const requestsBeforeFocus = meRequestCount;
  recoveryCodesRemaining = 2;
  delayNextMeRequest = true;
  delayedMeResponseStarted = false;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await waitForCondition(() => delayedMeResponseStarted, "Focus refresh should start its delayed /auth/me request");
  assert.equal(await passwordInput.inputValue(), "draft-password", "a delayed count response must not clobber the password draft");
  await waitForCount("3 unused recovery codes remaining.");
  await waitForCount("2 unused recovery codes remaining.");
  assert.equal(await passwordInput.inputValue(), "draft-password", "window-focus refresh must preserve the password draft");
  assert.ok(meRequestCount > requestsBeforeFocus, "window-focus should refresh the count from /auth/me");

  const requestsBeforeWrongPassword = meRequestCount;
  await page.getByRole("button", { name: "Regenerate codes" }).click();
  await page.getByText("Incorrect password", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await passwordInput.inputValue(), "draft-password", "wrong password must retain the password draft");
  await waitForCount("2 unused recovery codes remaining.");
  assert.equal(meRequestCount, requestsBeforeWrongPassword, "wrong-password response must not claim or trigger a refreshed count");
  assert.equal(await warning.isVisible(), true, "wrong password must not hide the existing low-count warning");

  await passwordInput.fill("correct-password");
  const regenerationButton = page.getByTestId("button-submit-recovery-code-regeneration");
  const regenerationRequestsBeforeSuccess = regenerationRequestCount;
  delaySuccessfulRegeneration = true;
  delayedRegenerationStarted = false;
  await regenerationButton.click();
  await waitForCondition(() => delayedRegenerationStarted, "Successful regeneration should be held while the UI is pending");
  assert.equal(await regenerationButton.isDisabled(), true, "the submit button must disable while regeneration is pending");
  assert.equal(await regenerationButton.innerText(), "Regenerating…");
  assert.equal(await passwordInput.inputValue(), "correct-password", "a delayed response must leave the current draft intact");
  await regenerationButton.dispatchEvent("click");
  assert.equal(regenerationRequestCount, regenerationRequestsBeforeSuccess + 1, "a pending regeneration must not submit a duplicate request");
  releaseDelayedRegeneration?.();
  await waitForCount("10 unused recovery codes remaining.");
  await warning.waitFor({ state: "detached" });
  for (const code of issuedCodes) {
    await page.getByText(code, { exact: true }).waitFor({ state: "visible" });
  }

  currentUserId = 157;
  recoveryCodesRemaining = 4;
  await page.getByTestId("button-refresh-test-auth").click();
  await waitForCount("4 unused recovery codes remaining.");
  for (const code of issuedCodes) {
    assert.equal(await page.getByText(code, { exact: true }).count(), 0, "account changes must clear previously issued plaintext codes");
  }

  countResponseUserIdOverride = 999;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await page.getByTestId("status-recovery-code-count-error").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("text-recovery-code-count").count(), 0, "an ownership mismatch must not display a prior or zero count");
  assert.match(await page.getByTestId("status-recovery-code-count-error").innerText(), /verify recovery code count for this account/i);
  countResponseUserIdOverride = null;
  await page.getByTestId("button-retry-recovery-code-count").click();
  await waitForCount("4 unused recovery codes remaining.");

  recoveryCodesRemaining = 0;
  await navigate();
  await waitForCount("0 unused recovery codes remaining.");
  await warning.getByText("You have no unused recovery codes. Generate a new set now to avoid losing backup access to your account.").waitFor({ state: "visible" });

  recoveryCodesRemaining = 7;
  currentRole = "client_staff";
  currentUserId = 156;
  billingLocked = false;
  const staffNavigation = await page.goto(`${baseUrl}/account-security`, { waitUntil: "domcontentloaded" });
  assert.ok(staffNavigation?.ok(), `Staff account-security navigation failed: ${staffNavigation?.status()}`);
  await page.getByRole("heading", { name: "Account Security" }).waitFor({ state: "visible" });
  await waitForCount("7 unused recovery codes remaining.");
  await page.getByTestId("link-account-security").waitFor({ state: "visible" });

  const staffSettingsNavigation = await page.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  assert.ok(staffSettingsNavigation?.ok(), `Staff settings navigation failed: ${staffSettingsNavigation?.status()}`);
  await page.getByRole("heading", { name: "404" }).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("text-recovery-code-count").count(), 0, "client_staff must not gain tenant settings access");

  currentRole = "client_viewer";
  const viewerNavigation = await page.goto(`${baseUrl}/account-security`, { waitUntil: "domcontentloaded" });
  assert.ok(viewerNavigation?.ok(), `Viewer account-security navigation failed: ${viewerNavigation?.status()}`);
  await page.getByRole("heading", { name: "Account Security" }).waitFor({ state: "visible" });
  await waitForCount("7 unused recovery codes remaining.");

  billingLocked = true;
  const lockedScreenNavigation = await page.goto(`${baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
  assert.ok(lockedScreenNavigation?.ok(), `Billing-locked screen navigation failed: ${lockedScreenNavigation?.status()}`);
  await page.getByRole("heading", { name: "Your free trial has ended" }).waitFor({ state: "visible" });
  await page.getByTestId("link-account-security-locked").click();
  await page.getByRole("heading", { name: "Account Security" }).waitFor({ state: "visible" });
  await waitForCount("7 unused recovery codes remaining.");

  assert.ok(csrfTokenRequestCount >= 2, "the shared auth helper should obtain CSRF tokens, including after the 401 reset");
  assert.equal(regenerationRequestCount, 2, "only the wrong-password and single successful requests should reach regeneration");
  assert.deepEqual(regenerationCsrfHeaders, ["browser-test-csrf", "browser-test-csrf"], "the API fixture must enforce CSRF on every regeneration request");

  console.log("Recovery-code count, warning, regeneration and freshness browser checks passed.");
} catch (error) {
  console.error("Recovery-code test page:", browser ? (await browser.contexts()[0]?.pages()[0]?.locator("body").innerText().catch(() => "")) : "");
  console.error("Recovery-code browser test failed:", error);
  throw error;
} finally {
  releaseDelayedRegeneration?.();
  await browser?.close();
  vite.kill("SIGTERM");
}