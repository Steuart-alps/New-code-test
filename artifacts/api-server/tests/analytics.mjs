// First-party analytics: ingest allowlist, privacy of stored rows, CSRF,
// session-only auth, per-session rate limit, the token-protected summary
// route, the 13-month retention purge and the analytics:report CLI.
//
// Runs the real app (full middleware chain) in-process against the fresh-
// schema harness's disposable database, so per-request settings
// (ENFORCE_CSRF, ANALYTICS_READ_TOKEN) can be switched between checks.
// Synthetic secrets only; no application database, mail or storage. Run:
//   bash tests/run-fresh-schema.sh tests/analytics.mjs
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFile = promisify(execFileCallback);

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1" || !process.env.DATABASE_URL) {
  throw new Error("Run through tests/run-fresh-schema.sh: a disposable database is required");
}
if (!/[?&]host=\//.test(process.env.DATABASE_URL)) {
  throw new Error("Refusing to run: DATABASE_URL is not the harness's private Unix-socket database");
}

// Synthetic, test-only secrets.
process.env.SESSION_SECRET = "analytics-test-session-secret-not-a-real-secret";
const READ_TOKEN = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
delete process.env.ANALYTICS_READ_TOKEN;
delete process.env.ENFORCE_CSRF;

const dir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(dir, "../../../scripts");
const outDir = await mkdtemp(path.join(dir, ".build-analytics-"));
let server;
let pool;

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "analytics.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  const entry = await import(pathToFileURL(outfile).href);
  pool = entry.pool;
  const { app, purgeExpiredAnalyticsEvents } = entry;

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api`;
  const q = async (text, values) => (await pool.query(text, values)).rows;
  const rowCount = async () => Number((await q(`SELECT count(*)::int AS n FROM analytics_events`))[0].n);

  function session() {
    let cookie = "";
    const request = async (method, urlPath, { body, headers = {} } = {}) => {
      const response = await fetch(`${base}${urlPath}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: response.status, text, data, headers: response.headers };
    };
    request.cookie = () => cookie;
    return request;
  }

  const password = "analytics-fixture-password-123";
  const stamp = Date.now();
  async function register(label) {
    const request = session();
    const email = `analytics-${label}-${stamp}@test.local`;
    const registered = await request("POST", "/auth/register", { body: { name: `Analytics ${label}`, email, password } });
    assert.equal(registered.status, 200, registered.text);
    assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
    return { email, userId: registered.data.user.id };
  }
  async function login(email) {
    const request = session();
    const result = await request("POST", "/auth/login", { body: { email, password } });
    assert.equal(result.status, 200, result.text);
    return request;
  }

  const adminAccount = await register("admin");
  const admin = await login(adminAccount.email);
  const me = await admin("GET", "/auth/me");
  const clientId = (me.data.user ?? me.data).clientId;
  assert.ok(Number.isInteger(clientId));
  const viewerAccount = await register("viewer");
  await q(`UPDATE users SET role = 'client_viewer', client_id = $1 WHERE id = $2`, [clientId, viewerAccount.userId]);
  const viewer = await login(viewerAccount.email);

  const post = (request, body, headers) => request("POST", "/analytics/events", { body, headers });
  const valid = { event: "training_matrix_download_started", dimensions: { site_scope: "all_sites" } };

  // ── Authentication ─────────────────────────────────────────────────────
  {
    const anonymous = session();
    assert.equal((await post(anonymous, valid)).status, 401, "unauthenticated requests are refused");
    assert.equal((await post(admin, valid, { authorization: "Bearer not-a-session" })).status, 401,
      "bearer requests (which skip CSRF) are refused even alongside a session");
    assert.equal(await rowCount(), 0);
    console.log("ok - unauthenticated and bearer requests get 401");
  }

  // ── Allowlist, and every event the web client emits today ──────────────
  {
    const emitted = [
      { event: "service_action_succeeded", dimensions: { service_key: "fixtrack", action: "add" } },
      { event: "service_action_succeeded", dimensions: { service_key: "doctrack", action: "remove" } },
      { event: "training_matrix_download_started", dimensions: { site_scope: "selected_site" } },
      { event: "module_activation_succeeded", dimensions: { module: "aquatrack" } },
      { event: "module_first_used", dimensions: { module: "dailytrack_am" } },
      { event: "module_first_work_completed", dimensions: { module: "firetrack", activity: "check_completed" } },
      { event: "module_first_work_completed", dimensions: { module: "doctrack", activity: "acknowledgement_recorded" } },
      { event: "inspection_pdf_download_started", dimensions: { module: "hottubtrack", site_scope: "all_sites", record_scope: "empty" } },
      { event: "inspection_pdf_download_started", dimensions: { module: "hottubtrack", site_scope: "selected_site", record_scope: "has_records" } },
    ];
    for (const body of emitted) {
      const result = await post(admin, body);
      assert.equal(result.status, 204, `${body.event} ${JSON.stringify(body.dimensions)}: ${result.text}`);
    }
    assert.equal(await rowCount(), emitted.length);

    const marker = "SecretMarker-Jane-Doe-42";
    const rejected = [
      { event: marker, dimensions: {} },
      { event: "training_matrix_download_started", dimensions: { site_scope: marker } },
      { event: "training_matrix_download_started", dimensions: { site_scope: "all_sites", site_id: marker } },
      { event: "training_matrix_download_started", dimensions: {} },
      { event: "training_matrix_download_started" },
      { event: "training_matrix_download_started", dimensions: { site_scope: 1 } },
      { event: "training_matrix_download_started", dimensions: { site_scope: ["all_sites"] } },
      { event: "training_matrix_download_started", dimensions: ["all_sites"] },
      { ...valid, clientId: marker },
      { ...valid, userId: 1 },
      { event: "inspection_pdf_download_started", dimensions: { module: "firetrack", site_scope: "all_sites", record_scope: "empty" } },
      { event: "module_first_used", dimensions: { module: marker } },
      { event: "constructor", dimensions: {} },
      { event: "__proto__", dimensions: {} },
      { event: "toString" },
      [valid],
      JSON.stringify(marker),
      `not json ${marker}`,
      {},
    ];
    for (const body of rejected) {
      const result = await post(admin, body);
      assert.equal(result.status, 400, `must reject ${JSON.stringify(body)}`);
      assert.ok(!result.text.includes(marker), "the response never echoes the input");
      // A body clientId is refused earlier by the global enforceClientAccess guard.
      const expected = body?.clientId ? "Invalid clientId" : "Unrecognised analytics event";
      if (typeof body === "object") assert.deepEqual(result.data, { error: expected });
    }
    const prototypeKey = await post(admin, '{"event":"training_matrix_download_started","dimensions":{"__proto__":{"site_scope":"all_sites"}}}');
    assert.equal(prototypeKey.status, 400);
    assert.equal(await rowCount(), emitted.length, "rejected events are not stored");
    console.log("ok - registered events stored; unregistered names, keys and values rejected without echo");
  }

  // ── Viewers may record usage ──────────────────────────────────────────────
  {
    assert.equal((await post(viewer, valid)).status, 204, "client_viewer usage is recorded");
    console.log("ok - client_viewer may record events (no tenant data is written)");
  }

  // ── No identifiers stored ───────────────────────────────────────────────
  {
    const columns = (await q(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'analytics_events' ORDER BY column_name`)).map((r) => r.column_name);
    assert.deepEqual(columns, ["dimensions", "event_name", "id", "occurred_at"], "no identity columns exist");
    const [row] = await q(`SELECT event_name, dimensions, occurred_at,
        occurred_at = date_trunc('hour', occurred_at) AS hour_truncated, row_to_json(analytics_events)::text AS raw
      FROM analytics_events ORDER BY id DESC LIMIT 1`);
    assert.equal(row.event_name, "training_matrix_download_started");
    assert.deepEqual(row.dimensions, { site_scope: "all_sites" }, "only the allowlisted dimension is stored");
    assert.equal(row.hour_truncated, true, "timestamps are truncated to the hour");
    const sessionId = decodeURIComponent(viewer.cookie().split("=")[1] ?? "").replace(/^s:/, "").split(".")[0];
    for (const forbidden of [viewerAccount.email, adminAccount.email, sessionId, "127.0.0.1", "node", "undici"]) {
      assert.ok(forbidden && !row.raw.toLowerCase().includes(forbidden.toLowerCase()), `row must not contain ${forbidden}`);
    }
    const all = await q(`SELECT DISTINCT jsonb_object_keys(dimensions) AS key FROM analytics_events ORDER BY 1`);
    assert.deepEqual(all.map((r) => r.key), ["action", "activity", "module", "record_scope", "service_key", "site_scope"]);
    console.log("ok - stored rows carry no user, client, session, IP or user agent");
  }

  // ── CSRF ─────────────────────────────────────────────────────────────────
  process.env.ENFORCE_CSRF = "1";
  try {
    // Node's fetch sends no Origin; Fetch Metadata stands in for a same-origin
    // browser request (the browser policy the CSRF middleware accepts).
    const sameOrigin = { "sec-fetch-site": "same-origin" };
    const before = await rowCount();
    assert.equal((await post(admin, valid, sameOrigin)).status, 403, "no token: refused");
    assert.equal((await post(admin, valid, { ...sameOrigin, "x-csrf-token": "wrong" })).status, 403, "wrong token: refused");
    const token = (await admin("GET", "/auth/csrf-token")).data.token;
    assert.equal(typeof token, "string");
    assert.equal((await post(admin, valid, { "sec-fetch-site": "cross-site", "x-csrf-token": token })).status, 403,
      "cross-site: refused even with the token");
    assert.equal((await post(admin, valid, { "x-csrf-token": token })).status, 403, "no browser provenance: refused");
    assert.equal(await rowCount(), before);
    assert.equal((await post(admin, valid, { ...sameOrigin, "x-csrf-token": token })).status, 204, "same-origin with token: stored");
    assert.equal(await rowCount(), before + 1);
    console.log("ok - CSRF token and same-origin provenance are required");
  } finally {
    delete process.env.ENFORCE_CSRF;
  }

  // ── Per-session rate limit ──────────────────────────────────────────────
  {
    const limited = await login(adminAccount.email);
    for (let i = 0; i < 60; i++) assert.equal((await post(limited, valid)).status, 204, `request ${i + 1}`);
    const blocked = await post(limited, valid);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await post(viewer, valid)).status, 204, "another session keeps its own quota");
    console.log("ok - 60 events per session per minute, then 429");
  }

  // ── Summary route ───────────────────────────────────────────────────────
  // Controlled fixture rows on two past UTC days, isolated by date range.
  const dayOffset = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const d1 = dayOffset(40);
  const d2 = dayOffset(39);
  const fixtures = [
    [d1, "training_matrix_download_started", { site_scope: "all_sites" }, 2],
    [d1, "training_matrix_download_started", { site_scope: "selected_site" }, 1],
    [d2, "training_matrix_download_started", { site_scope: "all_sites" }, 3],
    [d2, "module_first_used", { module: "firetrack" }, 4],
  ];
  for (const [day, event, dims, n] of fixtures) {
    for (let i = 0; i < n; i++) {
      await q(`INSERT INTO analytics_events (event_name, dimensions, occurred_at)
        VALUES ($1, $2::jsonb, ($3::date + interval '13 hours') AT TIME ZONE 'UTC')`, [event, JSON.stringify(dims), day]);
    }
  }
  const summaryPath = (query) => `${origin}/api/internal/analytics/summary?${new URLSearchParams(query)}`;
  const getSummary = async (query, headers = {}) => {
    const response = await fetch(summaryPath(query), { headers, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    return { status: response.status, text, data: text ? JSON.parse(text) : null, headers: response.headers };
  };
  const auth = { authorization: `Bearer ${READ_TOKEN}` };
  let httpSummary;
  {
    const range = { from: d1, to: d2 };
    assert.equal((await getSummary(range, auth)).status, 404, "disabled without ANALYTICS_READ_TOKEN");
    process.env.ANALYTICS_READ_TOKEN = "too-short";
    assert.equal((await getSummary(range, { authorization: "Bearer too-short" })).status, 404, "short tokens keep it disabled");
    process.env.ANALYTICS_READ_TOKEN = READ_TOKEN;

    assert.equal((await getSummary(range)).status, 401, "no token");
    const wrong = await getSummary(range, { authorization: `Bearer ${READ_TOKEN.slice(0, -1)}x` });
    assert.equal(wrong.status, 401, "wrong token");
    assert.equal(wrong.headers.get("www-authenticate"), "Bearer");
    assert.equal((await getSummary(range, { authorization: READ_TOKEN })).status, 401, "token without Bearer scheme");
    assert.equal((await getSummary(range, { cookie: admin.cookie() })).status, 401, "a session cookie is not enough");
    assert.equal((await getSummary(range, { cookie: admin.cookie(), authorization: "Bearer x" })).status, 401);

    const all = await getSummary(range, auth);
    assert.equal(all.status, 200, all.text);
    assert.equal(all.headers.get("cache-control"), "no-store");
    httpSummary = all.data;
    assert.equal(all.data.total, 10);
    assert.deepEqual(all.data.daily, [
      { date: d1, event: "training_matrix_download_started", count: 3 },
      { date: d2, event: "module_first_used", count: 4 },
      { date: d2, event: "training_matrix_download_started", count: 3 },
    ]);
    assert.deepEqual(all.data.totals, [
      { event: "module_first_used", count: 4 },
      { event: "training_matrix_download_started", count: 6 },
    ]);
    assert.ok(Array.isArray(all.data.events.training_matrix_download_started), "lists the registry for discovery");

    const grouped = await getSummary({ ...range, event: "training_matrix_download_started", groupBy: "site_scope" }, auth);
    assert.equal(grouped.status, 200, grouped.text);
    assert.deepEqual(grouped.data.daily, [
      { date: d1, event: "training_matrix_download_started", value: "all_sites", count: 2 },
      { date: d1, event: "training_matrix_download_started", value: "selected_site", count: 1 },
      { date: d2, event: "training_matrix_download_started", value: "all_sites", count: 3 },
    ]);
    assert.deepEqual(grouped.data.totals, [
      { event: "training_matrix_download_started", value: "all_sites", count: 5 },
      { event: "training_matrix_download_started", value: "selected_site", count: 1 },
    ]);
    const byModule = await getSummary({ from: d2, to: d2, groupBy: "module" }, auth);
    assert.deepEqual(byModule.data.daily, [{ date: d2, event: "module_first_used", value: "firetrack", count: 4 }]);

    for (const bad of [
      { from: d2, to: d1 }, { from: "2026-02-30", to: d2 }, { from: d1 }, { from: "yesterday", to: d2 },
      { from: "2020-01-01", to: "2026-01-01" }, { ...range, event: "nope_event" }, { ...range, groupBy: "client_id" },
      { ...range, event: "module_first_used", groupBy: "site_scope" }, { ...range, event: "DROP TABLE" },
    ]) {
      const result = await getSummary(bad, auth);
      assert.equal(result.status, 400, `bad query ${JSON.stringify(bad)}`);
    }
    const postAttempt = await fetch(`${origin}/api/internal/analytics/summary`, { method: "POST", headers: auth });
    // No write method exists: the request falls through to the session-
    // authenticated API, where the read token is not a credential.
    assert.ok([401, 404].includes(postAttempt.status), `read-only: no write method (${postAttempt.status})`);
    console.log("ok - summary: 404 when unset, 401 for missing/wrong token or cookie, correct daily and grouped counts");
  }

  // ── CLI ─────────────────────────────────────────────────────────────────
  {
    const tsx = path.join(scriptsDir, "node_modules/.bin/tsx");
    const cliEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL };
    const run = (args) => execFile(tsx, ["./src/analytics-report.ts", "--", ...args], { cwd: scriptsDir, env: cliEnv });
    const json = await run(["--from", d1, "--to", d2, "--json"]);
    const cliSummary = JSON.parse(json.stdout);
    const { events: _registry, ...httpAggregates } = httpSummary;
    assert.deepEqual(cliSummary, httpAggregates, "the CLI returns the same aggregates as the HTTP route");
    const text = await run(["--from", d1, "--to", d2, "--event", "training_matrix_download_started", "--group-by", "site_scope"]);
    assert.match(text.stdout, new RegExp(`Analytics summary: ${d1} to ${d2} \\(UTC\\), event=training_matrix_download_started, grouped by site_scope`));
    assert.match(text.stdout, /Total events: 6/);
    assert.match(text.stdout, /\s5 {2}training_matrix_download_started \[site_scope=all_sites\]/);
    assert.match(text.stdout, new RegExp(`${d1}\\s+1 {2}training_matrix_download_started \\[site_scope=selected_site\\]`));
    await assert.rejects(run(["--from", d2, "--to", d1]), (err) => err.code === 2 && /to must not be before from/.test(err.stderr));
    await assert.rejects(run(["--from", d1, "--to", d2, "--unknown"]), (err) => err.code === 2);
    console.log("ok - analytics:report CLI prints the same aggregates (text and --json)");
  }

  // ── Retention purge ─────────────────────────────────────────────────────
  {
    const old = [`now() - interval '13 months' - interval '1 day'`, `now() - interval '20 months'`, `now() - interval '5 years'`];
    for (const at of old) {
      await q(`INSERT INTO analytics_events (event_name, dimensions, occurred_at)
        VALUES ('module_first_used', '{"module":"pesttrack"}'::jsonb, ${at})`);
    }
    await q(`INSERT INTO analytics_events (event_name, dimensions, occurred_at)
      VALUES ('module_first_used', '{"module":"roomtrack"}'::jsonb, now() - interval '13 months' + interval '1 day')`);
    const before = await rowCount();
    assert.equal(await purgeExpiredAnalyticsEvents({ batchSize: 2 }), 3, "only rows older than 13 months, across batches");
    assert.equal(await rowCount(), before - 3);
    assert.equal((await q(`SELECT count(*)::int AS n FROM analytics_events WHERE dimensions->>'module' = 'pesttrack'`))[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int AS n FROM analytics_events WHERE dimensions->>'module' = 'roomtrack'`))[0].n, 1,
      "rows inside the retention window survive");
    assert.equal(await purgeExpiredAnalyticsEvents(), 0, "a re-run is a no-op");
    console.log("ok - retention purge removes only events older than 13 months");
  }

  console.log("First-party analytics checks passed.");
} finally {
  delete process.env.ANALYTICS_READ_TOKEN;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}
process.exit(0);
