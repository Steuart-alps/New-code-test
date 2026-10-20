// Manager review of public-link access evidence: role gate, tenant isolation,
// keyset pagination, filters and the guarantee that no token leaves the API.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const base = process.env.API_BASE;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1" || !base
    || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error("Run test:public-link-access with the disposable API/database harness.");
}

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, text };
  };
}

// SQL against the harness's disposable database only (never the app database).
async function psql(statement) {
  const { stdout } = await execFile("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", statement]);
  return stdout.trim();
}

const password = "link-access-fixture-password-123";
const stamp = Date.now();
async function account(label, setup) {
  const request = session();
  const email = `link-access-${label}-${stamp}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `Link ${label}`, email, password });
  assert.equal(registered.status, 200, registered.text);
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
  if (setup) await setup(email);
  assert.equal((await request("POST", "/auth/login", { email, password })).status, 200);
  const me = await request("GET", "/auth/me");
  const user = me.data.user ?? me.data;
  return { request, clientId: user.clientId, userId: user.id, role: user.role };
}

const sha = value => createHash("sha256").update(value).digest("hex");

async function allPages(request, query = "") {
  const ids = [];
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const params = new URLSearchParams(query);
    if (cursor) params.set("cursor", cursor);
    const response = await request("GET", `/public-link-access?${params}`);
    assert.equal(response.status, 200, response.text);
    pages.push(response.data.entries.length);
    ids.push(...response.data.entries.map(entry => entry.id));
    cursor = response.data.nextCursor;
    if (!cursor) return { ids, pages };
  }
  throw new Error("Pagination did not terminate");
}

test("public-link access history is manager-only, tenant-scoped, paginated and token-free", async t => {
  assert.equal((await session()("GET", "/public-link-access")).status, 401);

  const a = await account("A");
  const b = await account("B");

  // Real public-link traffic: each business's own sign-off link.
  const tokenA = randomBytes(24).toString("hex");
  const tokenB = randomBytes(24).toString("hex");
  await psql(`UPDATE clients SET sign_off_token='${tokenA}', sign_off_token_expires_at=now()+interval '1 day', sign_off_token_revoked_at=NULL WHERE id=${a.clientId}`);
  await psql(`UPDATE clients SET sign_off_token='${tokenB}', sign_off_token_expires_at=now()+interval '1 day', sign_off_token_revoked_at=NULL WHERE id=${b.clientId}`);
  const anonymous = session();
  assert.equal((await anonymous("GET", `/sign-off/${tokenA}/info`)).status, 200);
  assert.equal((await anonymous("GET", `/sign-off/${tokenA}/staff`)).status, 200);
  assert.equal((await anonymous("GET", `/sign-off/${tokenB}/info`)).status, 200);

  // Older history for A across every link type (two days ago, one per minute),
  // plus an unlabelled template and a row for B that must stay invisible to A.
  const portalFingerprint = sha(`portal-${stamp}`);
  const quoteFingerprint = sha(`quote-${stamp}`);
  const jobFingerprint = sha(`job-${stamp}`);
  await psql(`INSERT INTO public_link_access_evidence (client_id, link_type, token_fingerprint, action, created_at)
    SELECT ${a.clientId},
      (ARRAY['contractor_portal','fix_track_quote','fix_track_action'])[1 + n % 3],
      (ARRAY['${portalFingerprint}','${quoteFingerprint}','${jobFingerprint}'])[1 + n % 3],
      (ARRAY['GET /:token','POST /:token','POST /:token/booked'])[1 + n % 3],
      now() - interval '2 days' + n * interval '1 minute'
    FROM generate_series(1, 120) AS n`);
  await psql(`INSERT INTO public_link_access_evidence (client_id, link_type, token_fingerprint, action, created_at)
    VALUES (${a.clientId}, 'contractor_portal', '${portalFingerprint}', 'PATCH /:token/new-route', now() - interval '3 days'),
           (${b.clientId}, 'contractor_portal', '${sha(`b-${stamp}`)}', 'GET /:token', now() - interval '2 days')`);
  const totalA = Number(await psql(`SELECT count(*) FROM public_link_access_evidence WHERE client_id=${a.clientId}`));
  assert.equal(totalA, 123);

  await t.test("a manager sees every row of their own business, newest first, across pages", async () => {
    const first = await a.request("GET", "/public-link-access");
    assert.equal(first.status, 200, first.text);
    assert.equal(first.data.entries.length, 50);
    assert.equal(typeof first.data.nextCursor, "string");
    const [newest, second] = first.data.entries;
    assert.equal(newest.linkType, "sign_off");
    assert.equal(newest.activity, "Listed staff names");
    assert.equal(newest.actionType, "view");
    assert.equal(newest.linkRef, sha(tokenA).slice(0, 8));
    assert.equal(second.activity, "Opened the sign-off page");
    assert.deepEqual(Object.keys(newest).sort(), ["actionType", "activity", "id", "linkRef", "linkType", "occurredAt"]);

    const { ids, pages } = await allPages(a.request);
    assert.deepEqual(pages, [50, 50, 23]);
    assert.equal(new Set(ids).size, totalA, "no row repeated or skipped between pages");
    const expected = (await psql(`SELECT id FROM public_link_access_evidence WHERE client_id=${a.clientId} ORDER BY created_at DESC, id DESC`)).split("\n").map(Number);
    assert.deepEqual(ids, expected);

    const small = await allPages(a.request, "limit=7");
    assert.equal(small.ids.length, totalA);
    assert.ok(small.pages.every(count => count <= 7));
  });

  await t.test("filters by link type, action and time", async () => {
    const quotes = await allPages(a.request, "linkType=fix_track_quote");
    assert.equal(quotes.ids.length, 40);
    const signOff = await a.request("GET", "/public-link-access?linkType=sign_off");
    assert.equal(signOff.data.entries.length, 2);
    const views = await allPages(a.request, "actionType=view");
    assert.equal(views.ids.length, 42, "40 portal opens + 2 sign-off views");
    const submits = await allPages(a.request, "actionType=submit");
    assert.equal(submits.ids.length, 81, "quotes, bookings and the unlabelled PATCH");
    const recent = await a.request("GET", `/public-link-access?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`);
    assert.deepEqual(recent.data.entries.map(entry => entry.linkType), ["sign_off", "sign_off"]);
    const older = await allPages(a.request, `to=${encodeURIComponent(new Date(Date.now() - 2.5 * 86_400_000).toISOString())}`);
    assert.equal(older.ids.length, 1);
    const unknown = await a.request("GET", `/public-link-access?to=${encodeURIComponent(new Date(Date.now() - 2.5 * 86_400_000).toISOString())}`);
    assert.equal(unknown.data.entries[0].activity, "Other link activity");
    assert.equal(unknown.data.entries[0].actionType, "submit");
    for (const bad of ["linkType=email", "actionType=delete", "limit=0", "limit=101", "limit=2.5", "from=yesterday", "cursor=not-a-cursor",
      `cursor=${Buffer.from(JSON.stringify({ t: "1 OR 1=1", id: 1 })).toString("base64url")}`]) {
      assert.equal((await a.request("GET", `/public-link-access?${bad}`)).status, 400, bad);
    }
  });

  await t.test("never returns tokens or full fingerprints", async () => {
    const response = await a.request("GET", "/public-link-access?limit=100");
    for (const secret of [tokenA, tokenB, sha(tokenA), portalFingerprint, quoteFingerprint, jobFingerprint, ":token"]) {
      assert.ok(!response.text.includes(secret), `response must not contain ${secret.slice(0, 12)}…`);
    }
    for (const entry of response.data.entries) assert.match(entry.linkRef, /^[0-9a-f]{8}$/);
  });

  await t.test("other businesses' history is unreachable", async () => {
    const own = await allPages(b.request);
    assert.equal(own.ids.length, 2, "B sees only its own sign-off view and portal row");
    const aIds = new Set((await allPages(a.request)).ids);
    assert.ok(own.ids.every(id => !aIds.has(id)));
    assert.equal((await a.request("GET", `/public-link-access?clientId=${b.clientId}`)).status, 403);
    assert.equal((await b.request("GET", `/public-link-access?clientId=${a.clientId}`)).status, 403);
    // A cursor minted for one business cannot pull another business's rows.
    const bPage = await b.request("GET", "/public-link-access?limit=1");
    const crossed = await a.request("GET", `/public-link-access?cursor=${bPage.data.nextCursor}`);
    assert.equal(crossed.status, 200);
    assert.ok(crossed.data.entries.every(entry => aIds.has(entry.id)));
  });

  await t.test("client admins can review; staff and viewers cannot", async () => {
    // One account moved between roles (sign-up is rate limited per address).
    const member = await account("member", email => psql(`UPDATE users SET role='client_staff', client_id=${a.clientId} WHERE email='${email}'`));
    assert.equal(member.role, "client_staff");
    assert.equal((await member.request("GET", "/public-link-access")).status, 403, "client_staff");
    await psql(`UPDATE users SET role='client_viewer' WHERE id=${member.userId}`);
    assert.equal((await member.request("GET", "/public-link-access")).status, 403, "client_viewer");
    await psql(`UPDATE users SET role='client_admin' WHERE id=${member.userId}`);
    const adminView = await allPages(member.request);
    assert.equal(adminView.ids.length, totalA);
    assert.equal((await member.request("GET", `/public-link-access?clientId=${b.clientId}`)).status, 403);
  });

  await t.test("a consultant linked to both businesses reads each one only when selected", async () => {
    const consultant = await account("consultant", async email => {
      const userId = await psql(`SELECT id FROM users WHERE email='${email}'`);
      await psql(`UPDATE users SET role = 'consultant' WHERE id = ${userId}`);
      await psql(`INSERT INTO consultant_clients (user_id, client_id) VALUES (${userId}, ${a.clientId}), (${userId}, ${b.clientId})`);
    });
    const forA = await allPages(consultant.request, `clientId=${a.clientId}`);
    assert.equal(forA.ids.length, totalA);
    const forB = await allPages(consultant.request, `clientId=${b.clientId}`);
    assert.equal(forB.ids.length, 2);
    const own = await consultant.request("GET", "/public-link-access");
    assert.equal(own.status, 200);
    assert.equal(own.data.entries.length, 0, "the consultant's own business has no link traffic");
  });
});
