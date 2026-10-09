// Shared sign-in, provider and cleanup helpers for the provider-backed private
// document ACL suites (doc-track-object-acl.mjs, generic-document-object-acl.mjs).
//
// Sessions follow whichever policy the API under test enforces: when the
// production CSRF check rejects a mutation, the session switches to the web
// app's same-origin Origin + session-bound X-CSRF-Token; a login that asks for
// mandatory 2FA enrolment completes it through the normal endpoints. The
// legacy test bypasses need neither, so the suites pass under either policy.
//
// Provider assertions read object metadata straight from the dedicated test
// bucket via tests/storage-happy-path-fixture.mjs. They never touch application
// storage: without the fixture they are reported as SKIP, and required-storage
// mode (STORAGE_TEST_REQUIRE_AVAILABLE=1) refuses to run without it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { purgeOwnedFixtures, resolveRunId } from "./fixture-ownership.mjs";
import { openStorageFixture, storageFixtureConfigured } from "./storage-happy-path-fixture.mjs";

export const BASE = process.env.API_BASE;
if (!BASE) {
  throw new Error("API_BASE is required (run through tests/run-storage-happy-path.sh or its standalone runner)");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required so this suite can remove and verify its own fixture rows");
}
const ORIGIN = new URL(BASE).origin;
const PASSWORD = "storage-acl-fixture-123";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function session() {
  let cookie = "";
  let csrfToken = null;
  async function send(method, path, body, extraHeaders = {}) {
    const response = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
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
    const contentType = response.headers.get("content-type") ?? "";
    const raw = Buffer.from(await response.arrayBuffer());
    let data = null;
    if (contentType.includes("application/json")) {
      try { data = JSON.parse(raw.toString("utf8")); } catch { data = null; }
    }
    return { status: response.status, data, bytes: data === null ? raw : null, text: data === null ? raw.toString("utf8") : null };
  }
  let browserPolicy = false;
  return async function request(method, path, body) {
    if (method === "GET" || method === "HEAD") return send(method, path, body);
    if (!browserPolicy) {
      const result = await send(method, path, body);
      // The CSRF middleware rejects before any route handler runs, so the
      // request can be repeated with the web app's same-origin credentials.
      if (result.status !== 403 || result.data?.error !== "CSRF validation failed") return result;
      browserPolicy = true;
    }
    if (!csrfToken) {
      const issued = await send("GET", "/auth/csrf-token");
      assert.equal(issued.status, 200, `CSRF token: ${JSON.stringify(issued.data)}`);
      csrfToken = issued.data.token;
    }
    const result = await send(method, path, body, { origin: ORIGIN, "x-csrf-token": csrfToken });
    if (path.startsWith("/auth/")) csrfToken = null;
    return result;
  };
}

function currentTotp(secret) {
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

async function login(request, email, label) {
  const response = await request("POST", "/auth/login", { email, password: PASSWORD });
  assert.equal(response.status, 200, `${label}: login`);
  if (response.data?.requires2faSetup) {
    // Mandatory 2FA is enforced: enrol through the normal endpoints.
    const setup = await request("GET", "/auth/2fa/setup");
    assert.equal(setup.status, 200, `${label}: 2FA setup`);
    const enabled = await request("POST", "/auth/2fa/enable", { code: currentTotp(setup.data.secret) });
    assert.equal(enabled.status, 200, `${label}: 2FA enrolment`);
  } else {
    assert.notEqual(response.data?.requires2fa, true, `${label}: fresh account unexpectedly needs a 2FA code`);
  }
  const me = await request("GET", "/auth/me");
  assert.equal(me.status, 200, `${label}: session established`);
  const user = me.data?.user ?? me.data;
  assert.equal(Number.isInteger(user?.clientId), true, `${label}: user has a client`);
  return user;
}

/** Run-owned fixtures: every email carries the run id; cleanup purges and verifies. */
export function createRun(suite) {
  const runId = resolveRunId();
  const clientIds = new Set();
  const objectPaths = new Set();
  let registeredUsers = 0;

  async function registerTenant(label) {
    const request = session();
    const email = `${suite}-${label}-${runId}-${randomUUID()}@test.local`;
    const registered = await request("POST", "/auth/register", { name: `${suite} ${label}`, email, password: PASSWORD });
    assert.equal(registered.status, 200, `${label}: register tenant`);
    registeredUsers += 1;
    assert.equal(typeof registered.data?.verificationToken, "string", `${label}: test verification token`);
    const verified = await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
    assert.equal(verified.status, 200, `${label}: verify tenant`);
    const user = await login(request, email, label);
    clientIds.add(user.clientId);
    return { request, clientId: user.clientId, userId: user.id };
  }

  /** A second, ordinary staff user in the tenant, created through POST /users. */
  async function addSameClientUser(owner, label) {
    const email = `${suite}-${label}-${runId}-${randomUUID()}@test.local`;
    const created = await owner.request("POST", "/users", {
      name: `${suite} ${label}`, email, password: PASSWORD, role: "client_staff", clientId: owner.clientId,
    });
    assert.equal(created.status, 201, `${label}: create same-client user`);
    assert.equal(created.data?.clientId, owner.clientId, `${label}: user belongs to the uploading client`);
    const request = session();
    const user = await login(request, email, label);
    assert.equal(user.clientId, owner.clientId, `${label}: signed in to the uploading client`);
    assert.notEqual(user.id, owner.userId, `${label}: distinct user from the uploader`);
    return { request, clientId: user.clientId, userId: user.id };
  }

  const fixture = () => (storageFixtureConfigured() || process.env.STORAGE_TEST_REQUIRE_AVAILABLE === "1"
    ? openStorageFixture()
    : null);

  /**
   * Read the stored object's metadata from the provider and assert the private
   * tenant ACL. Returns false (with SKIP) only outside the dedicated fixture.
   */
  async function assertProviderAcl(objectPath, { ownerClientId, bytes }) {
    objectPaths.add(objectPath);
    const storage = fixture();
    if (!storage) {
      console.log(`SKIP: provider ACL metadata check for ${suite} needs the dedicated bucket (pnpm --filter @workspace/api-server run test:storage-happy-path)`);
      return false;
    }
    const [metadata] = await storage.fileFor(objectPath).getMetadata();
    assert.equal(metadata.bucket, storage.bucketName, "object is stored in the dedicated test bucket");
    const policy = JSON.parse(metadata.metadata?.["custom:aclPolicy"] ?? "null");
    assert.equal(policy?.owner, String(ownerClientId), "stored ACL owner is the uploading client");
    assert.equal(policy?.visibility, "private", "stored ACL visibility is private");
    assert.equal(Number(metadata.size), bytes.length, "provider size matches the uploaded bytes");
    assert.equal(metadata.md5Hash, createHash("md5").update(bytes).digest("base64"), "provider MD5 matches the uploaded bytes");
    return true;
  }

  async function assertProviderHasNoAcl(objectPath) {
    objectPaths.add(objectPath);
    const storage = fixture();
    if (!storage) return;
    const [metadata] = await storage.fileFor(objectPath).getMetadata();
    assert.equal(metadata.metadata?.["custom:aclPolicy"], undefined, "uploaded object has no ACL before registration");
  }

  /** Remove this run's objects and rows, then prove both are gone. */
  async function cleanup() {
    const storage = fixture();
    if (storage) {
      for (const objectPath of objectPaths) {
        const file = storage.fileFor(objectPath);
        await file.delete({ ignoreNotFound: true });
        const [exists] = await file.exists();
        assert.equal(exists, false, `fixture object removed: ${objectPath}`);
      }
      if (objectPaths.size) console.log(`${suite}: removed ${objectPaths.size} fixture object(s) from the dedicated bucket`);
    } else if (objectPaths.size) {
      console.log(`SKIP: ${suite} leaves object removal to storage lifecycle outside the dedicated fixture`);
    }
    const ids = [...clientIds];
    console.log(`${suite}: ${await purgeOwnedFixtures({ runId, clientIds: ids, minUsers: registeredUsers > 0 ? 1 : 0 })}`);
    const remaining = await psqlScalar(`
      SELECT (SELECT count(*) FROM clients WHERE id = ANY(ARRAY[${ids.join(",") || "0"}]::integer[]))
           + (SELECT count(*) FROM users WHERE email LIKE '%${runId}%@test.local')
           + (SELECT count(*) FROM doc_track_documents WHERE client_id = ANY(ARRAY[${ids.join(",") || "0"}]::integer[]))
           + (SELECT count(*) FROM client_documents WHERE client_id = ANY(ARRAY[${ids.join(",") || "0"}]::integer[]))`);
    assert.equal(remaining, "0", `${suite}: fixture rows removed`);
    console.log(`${suite}: fixture cleanup verified (${ids.length} client(s), no rows left)`);
  }

  return { runId, registerTenant, addSameClientUser, assertProviderAcl, assertProviderHasNoAcl, cleanup };
}

/** Fetch an app download link (absolute, from getPublicAppUrl) against the API under test. */
export function appDownloadPath(downloadUrl) {
  const { pathname } = new URL(downloadUrl);
  assert.match(pathname, /^\/api\/storage\/download\/[A-Za-z0-9_-]{40,60}$/, "download link is an app token URL");
  return `${ORIGIN}${pathname}`;
}

function psqlScalar(sqlText) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", process.env.DATABASE_URL, "-f", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`fixture verification query failed (psql exit ${code}): ${stderr.split(process.env.DATABASE_URL).join("<DATABASE_URL>").trim()}`))));
    child.stdin.end(sqlText);
  });
}
