import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

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

export function requestSession() {
  let cookie = "";
  return async (method, path, body, format = "json") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: format === "buffer" ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => null) };
  };
}

const password = "private-approval-fixture-123";
export async function createTenant(label) {
  const request = requestSession();
  const email = `approval-${label}-${randomUUID()}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `${label} manager`, email, password });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal(typeof registered.data.verificationToken, "string");
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
  assert.equal((await request("POST", "/auth/login", { email, password })).status, 200);
  const me = await request("GET", "/auth/me");
  const user = me.data.user ?? me.data;
  assert.ok(Number.isInteger(user.clientId));
  return { request, clientId: user.clientId, userId: user.id };
}

export async function createUser(owner, body) {
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
  const request = requestSession();
  assert.equal((await request("POST", "/auth/login", { email, password })).status, 200);
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