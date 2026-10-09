import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, randomUUID } from "node:crypto";

export const base = process.env.API_BASE;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname)
    || !process.env.DATABASE_URL?.includes("host=/tmp/")
    || !process.env.FIXTRACK_TEST_EMAIL_OUTBOX) {
  throw new Error("Approval fixtures require the disposable database/API and captured email harness.");
}

const temp = await mkdtemp(fileURLToPath(new URL(".build-approval-fixtures-", import.meta.url)));
let runtime;
try {
  const output = `${temp}/runtime.mjs`;
  await build({
    entryPoints: [fileURLToPath(new URL("./approval-workflow-fixtures.entry.ts", import.meta.url))],
    outfile: output,
    bundle: true, platform: "node", format: "esm",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  runtime = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}
export const {
  db, sql, pool, runReminderJob, runRuntimeMigrations, decryptTokenPayload,
  encryptTokenPayload, tokenPayloadNeedsReencryption, reencryptQueuedTokenPayloads,
} = runtime;

// With `browserPolicy`, the session behaves like the same-origin web app under
// the production CSRF policy: unsafe requests carry the API origin and the
// session-bound X-CSRF-Token from /auth/csrf-token. Legacy suites keep the
// original header-free contract.
export function requestSession({ browserPolicy = false } = {}) {
  let cookie = "";
  let csrfToken = null;
  const origin = new URL(base).origin;
  const send = async (method, path, body, format, extraHeaders = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie && setCookie.split(";")[0] !== cookie) {
      cookie = setCookie.split(";")[0];
      csrfToken = null;
    }
    return { status: response.status, data: format === "buffer" ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => null) };
  };
  const request = async (method, path, body, format = "json") => {
    if (!browserPolicy || ["GET", "HEAD"].includes(method)) return send(method, path, body, format);
    if (!csrfToken) {
      const issued = await send("GET", "/auth/csrf-token", undefined, "json");
      assert.equal(issued.status, 200, JSON.stringify(issued.data));
      csrfToken = issued.data.token;
    }
    const result = await send(method, path, body, format, { origin, "x-csrf-token": csrfToken });
    // Authentication steps may change the session; fetch a fresh token next time.
    if (path.startsWith("/auth/")) csrfToken = null;
    return result;
  };
  request.cookie = () => cookie;
  return request;
}

export function currentTotp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// Complete mandatory authenticator enrolment through the normal endpoints for
// a session whose login returned `requires2faSetup`.
async function enrolTwoFactor(request, login) {
  assert.equal(login.data?.requires2faSetup, true, `mandatory 2FA must be enforced: ${JSON.stringify(login.data)}`);
  const setup = await request("GET", "/auth/2fa/setup");
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const enabled = await request("POST", "/auth/2fa/enable", { code: currentTotp(setup.data.secret) });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
}

const password = "private-approval-fixture-123";
export async function createTenant(label, { browserPolicy = false } = {}) {
  const request = requestSession({ browserPolicy });
  const email = `approval-${label}-${randomUUID()}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `${label} manager`, email, password });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal(typeof registered.data.verificationToken, "string");
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
  const login = await request("POST", "/auth/login", { email, password });
  assert.equal(login.status, 200);
  if (browserPolicy) await enrolTwoFactor(request, login);
  const me = await request("GET", "/auth/me");
  const user = me.data.user ?? me.data;
  assert.ok(Number.isInteger(user.clientId));
  return { request, clientId: user.clientId, userId: user.id };
}

export async function createUser(owner, body, { browserPolicy = false } = {}) {
  const email = `approval-user-${randomUUID()}@test.local`;
  const created = await owner.request("POST", "/users", {
    name: "Approval fixture user", email, password, clientId: owner.clientId, ...body,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const managerFlags = {};
  for (const key of ["isMaintenanceManager", "isDepartmentManager"]) {
    if (body[key] !== undefined) managerFlags[key] = body[key];
  }
  if (Object.keys(managerFlags).length) {
    const updated = await owner.request("PUT", `/users/${created.data.id}`, managerFlags);
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
  }
  const request = requestSession({ browserPolicy });
  const login = await request("POST", "/auth/login", { email, password });
  assert.equal(login.status, 200);
  if (browserPolicy) await enrolTwoFactor(request, login);
  return { request, userId: created.data.id };
}

export async function readOutbox() {
  const content = await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8");
  return content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
export async function clearOutbox() {
  await writeFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "");
}
export function isoDay(offset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}