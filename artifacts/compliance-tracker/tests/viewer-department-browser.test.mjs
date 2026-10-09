import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHmac } from "node:crypto";
import { chromium } from "@playwright/test";

const apiBase = process.env.VIEWER_TEST_API;
assert.ok(apiBase, "Run through test:viewer-department-browser to start a test-mode API");

const freePort = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
};
function currentTotp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test", REPL_ID: undefined },
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
    executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const apiResponses = [];
  page.on("response", response => {
    if (response.url().includes("/api/")) apiResponses.push(`${response.status()} ${response.url()}`);
  });
  // Vite serves the real React app; forward only API calls to the private
  // test-mode API. Browser cookies still use the same 127.0.0.1 host.
  await page.route(`${baseUrl}/api/**`, async route => {
    const target = `${apiBase}${new URL(route.request().url()).pathname.slice(4)}${new URL(route.request().url()).search}`;
    const headers = { ...route.request().headers() };
    // This is a same-origin browser request, not a cross-origin request from
    // the Vite port. Keep the proxy's upstream request free of a foreign Origin.
    delete headers.origin;
    const response = await route.fetch({ url: target, headers });
    await route.fulfill({ response });
  });

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `viewer-edit-admin-${suffix}@test.local`;
  const viewerEmail = `viewer-edit-${suffix}@test.local`;
  const viewerName = `Viewer Edit ${suffix}`;
  const request = context.request;
  const register = await request.post(`${apiBase}/auth/register`, {
    data: { name: "Viewer Edit Admin", email, password: "password-123" },
  });
  assert.ok(register.ok(), `registration: ${register.status()} ${await register.text()}`);
  const { verificationToken } = await register.json();
  assert.ok(verificationToken, "test API should return email verification token");
  const verify = await request.get(`${apiBase}/auth/verify-email?token=${verificationToken}`);
  assert.ok(verify.ok(), `email verification: ${verify.status()}`);
  const login = await request.post(`${apiBase}/auth/login`, {
    data: { email, password: "password-123" },
  });
  assert.ok(login.ok(), `admin login: ${login.status()} ${await login.text()}`);
  const setup = await request.get(`${apiBase}/auth/2fa/setup`);
  assert.ok(setup.ok(), `admin 2FA setup: ${setup.status()}`);
  const { secret } = await setup.json();
  const enabled = await request.post(`${apiBase}/auth/2fa/enable`, {
    data: { code: currentTotp(secret) },
  });
  assert.ok(enabled.ok(), `admin 2FA enrolment: ${enabled.status()} ${await enabled.text()}`);
  const clientId = (await (await request.get(`${apiBase}/auth/me`)).json()).user.clientId;
  assert.ok(Number.isInteger(clientId), "registered administrator needs a client");

  const deptName = `Viewer scope ${suffix}`;
  const department = await request.post(`${apiBase}/departments`, { data: { name: deptName } });
  assert.ok(department.ok(), `create department: ${department.status()} ${await department.text()}`);
  const { id: departmentId } = await department.json();
  const createViewer = await request.post(`${apiBase}/users`, {
    data: { name: viewerName, email: viewerEmail, password: "password-456",
      role: "client_viewer", clientId, departmentId: null },
  });
  assert.ok(createViewer.ok(), `create viewer: ${createViewer.status()} ${await createViewer.text()}`);
  const { id: viewerId } = await createViewer.json();

  const navigation = await page.goto(`${baseUrl}/users`);
  assert.ok(navigation?.ok(), `Users page navigation: ${navigation?.status()}`);
  const row = () => page.getByRole("row").filter({ hasText: viewerEmail });
  try {
    await row().waitFor({ state: "visible", timeout: 10000 });
  } catch (error) {
    console.error("Users page URL:", page.url());
    console.error("Users page text:", (await page.locator("body").innerText()).slice(0, 1200));
    console.error("API responses:", apiResponses);
    throw error;
  }
  const edit = async () => {
    await row().getByRole("button", { name: `Edit ${viewerName}` }).click();
    const dialog = page.getByRole("dialog", { name: "Edit User" });
    await dialog.getByRole("combobox").last().waitFor({ state: "visible" });
    return dialog;
  };
  const assertStored = async expectedId => {
    const response = await request.get(`${apiBase}/users`);
    assert.ok(response.ok(), `reload users data: ${response.status()}`);
    const viewer = (await response.json()).find(user => user.id === viewerId);
    assert.equal(viewer?.role, "client_viewer");
    assert.equal(viewer.departmentId, expectedId, "saved viewer department must persist in API");
    await page.reload();
    await row().waitFor({ state: "visible" });
    await row().getByRole("combobox").getByText(
      expectedId === null ? "All departments" : deptName, { exact: true },
    ).waitFor({ state: "visible" });
    const dialog = await edit();
    await dialog.getByRole("combobox").last().getByText(
      expectedId === null ? "No department" : deptName, { exact: true },
    ).waitFor({ state: "visible" });
    return dialog;
  };

  let dialog = await edit();
  await dialog.getByRole("combobox").last().click();
  await page.getByRole("option", { name: deptName }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  dialog = await assertStored(departmentId);

  await dialog.getByRole("combobox").last().click();
  await page.getByRole("option", { name: "No department" }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  dialog = await assertStored(null);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  console.log("Viewer department edit, reload and clear browser test passed.");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}