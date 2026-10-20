// Verification-link page and signup email recovery, with the API stubbed:
// the link's token is read from the query string, an expired link offers a
// new one, sign-in carries the address over, and the resend copy never says
// whether an account exists.
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

const json = (route, data, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(data),
});

const GOOD_TOKEN = "a".repeat(64);
const EXPIRED_TOKEN = "b".repeat(64);
const verifyCalls = [];
const resendBodies = [];
let resendStatus = 200;

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => console.error(`[browser:error] ${error.message}`));
  await page.route(url => new URL(url).pathname.startsWith("/api/"), async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/csrf-token") return json(route, { token: "browser-test-csrf" });
    if (url.pathname === "/api/auth/me") return json(route, { error: "Unauthorized" }, 401);
    if (url.pathname === "/api/auth/verify-email") {
      const token = url.searchParams.get("token");
      verifyCalls.push(token);
      return token === GOOD_TOKEN
        ? json(route, { verified: true })
        : json(route, { error: "This verification link is invalid or has expired." }, 400);
    }
    if (url.pathname === "/api/auth/resend-verification") {
      resendBodies.push(JSON.parse(route.request().postData() ?? "{}"));
      return resendStatus === 200
        ? json(route, { sent: true })
        : json(route, { error: "Too many attempts. Please try again later." }, resendStatus);
    }
    if (url.pathname === "/api/auth/login") {
      return json(route, { error: "Please verify your email address before signing in.", requiresEmailVerification: true }, 403);
    }
    return json(route, {});
  });

  // The emailed link verifies the account.
  await page.goto(`${baseUrl}/verify-email?token=${GOOD_TOKEN}`);
  await page.getByRole("heading", { name: "Email verified" }).waitFor();
  assert.deepEqual(verifyCalls, [GOOD_TOKEN], "the page sends the link's token");

  // An expired link explains itself and offers a new one.
  await page.goto(`${baseUrl}/verify-email?token=${EXPIRED_TOKEN}`);
  await page.getByRole("heading", { name: "Verification link unavailable" }).waitFor();
  await page.getByText("You can ask for a new link below.").waitFor();
  await page.getByLabel("Email address").fill("owner@example.com");
  await page.getByRole("button", { name: "Send a new verification link" }).click();
  await page.getByText("If that address has an account waiting to be verified").waitFor();
  assert.deepEqual(resendBodies.at(-1), { email: "owner@example.com" });

  // Signing in before verifying lands on the page with the address filled in.
  await page.goto(`${baseUrl}/login`);
  await page.fill("#email", "new.owner@example.com");
  await page.fill("input[type=password]", "password-123456");
  await page.click("button[type=submit]");
  await page.getByRole("heading", { name: "Check your inbox" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("email"), "new.owner@example.com");
  assert.equal(await page.getByLabel("Email address").inputValue(), "new.owner@example.com");
  await page.getByText("Check your spam or junk folder.").waitFor();

  // A rate limit is reported; nothing reveals whether the account exists.
  resendStatus = 429;
  await page.getByRole("button", { name: "Send a new verification link" }).click();
  await page.getByText("Too many requests for now").waitFor();
  assert.deepEqual(resendBodies.at(-1), { email: "new.owner@example.com" });

  console.log("verify-email browser test passed");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
