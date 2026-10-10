// Shared sign-in helpers for the real API/storage browser round trips
// (photo-storage-roundtrip-browser.test.mjs, fixtrack-video-roundtrip-browser.test.mjs).
// Every account goes through the production auth flow: email verification,
// CSRF-protected mutations and mandatory 2FA enrolment.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

export function currentTotp(secret) {
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

/** Same-origin fetch from inside the signed-in page, with the session's CSRF token unless disabled. */
export async function api(page, method, path, body, { csrf = true } = {}) {
  return page.evaluate(async ({ method, path, body, csrf }) => {
    const headers = { "Content-Type": "application/json" };
    if (csrf && method !== "GET") {
      const tokenResponse = await fetch("/api/auth/csrf-token", { credentials: "same-origin" });
      headers["x-csrf-token"] = (await tokenResponse.json()).token;
    }
    const response = await fetch(`/api${path}`, {
      method, headers, credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, data, text: text.slice(0, 500), contentType: response.headers.get("content-type") };
  }, { method, path, body, csrf });
}

/** Log in on an already-open app page, enrolling the mandatory 2FA on first sign-in. */
export async function signIn(page, label, email, password) {
  const login = await api(page, "POST", "/auth/login", { email, password }, { csrf: false });
  assert.equal(login.data?.requires2faSetup, true, `${label} login must hold the session for mandatory 2FA: ${login.text}`);
  assert.equal((await api(page, "GET", "/sites")).status, 401, `${label}: app routes stay closed until 2FA is enrolled`);
  const setup = await api(page, "GET", "/auth/2fa/setup");
  assert.equal(setup.status, 200, `${label} 2FA setup: ${setup.text}`);
  const enabled = await api(page, "POST", "/auth/2fa/enable", { code: currentTotp(setup.data.secret) });
  assert.equal(enabled.status, 200, `${label} 2FA enrolment: ${enabled.text}`);
  const me = await api(page, "GET", "/auth/me");
  assert.equal(me.status, 200, `${label} session after 2FA: ${me.text}`);
  return me.data;
}

/**
 * Register an isolated tenant through the real auth flow, including mandatory
 * 2FA enrolment. Returns the signed-in page and the tenant's client id.
 */
export async function signUpTenant(context, { appUrl, label, email, password, name }) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const landing = await page.goto(`${appUrl}/login`);
  assert.ok(landing?.ok(), `${label}: web app served by the API (${landing?.status()})`);
  const registered = await api(page, "POST", "/auth/register", { name, email, password }, { csrf: false });
  assert.equal(registered.status, 200, `${label} registration: ${registered.text}`);
  const verified = await api(page, "GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  assert.equal(verified.status, 200, `${label} email verification: ${verified.text}`);
  const me = await signIn(page, label, email, password);
  const clientId = me?.user?.clientId;
  assert.ok(Number.isInteger(clientId), `${label} needs its own client`);
  return { page, clientId };
}
