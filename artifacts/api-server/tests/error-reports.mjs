// Error reports (Sentry), end to end against a fake Sentry ingest server.
//
//   1. Production without SENTRY_DSN starts cleanly: /healthz ok, the log says
//      monitoring is disabled, and /readyz notes errorReports configured:false
//      (nothing claims alerts are on).
//   2. With SENTRY_DSN pointing at the fake ingest:
//        - the test-report route is platform-operator only (403 otherwise)
//        - an operator's test report is accepted by "Sentry" and the event
//          carries the environment (NODE_ENV) and release (RENDER_GIT_COMMIT)
//          tags, the request method and path
//        - nothing secret leaves: no cookie, CSRF or bearer header, query
//          string, request body or the operator's email in what was sent
//
// Usage: DATABASE_URL=... node tests/error-reports.mjs (after `pnpm run build`;
// normally via `pnpm run test:error-reports:ci`). Exits 1 on any failure.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";
import { promoteToConsultant } from "./consultant-account.mjs";

const runId = resolveRunId();
const fixtures = createFixtureOwnership({ runId, suite: "error-reports" });

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

// ── Fake Sentry ingest ──────────────────────────────────────────────────────
const envelopes = [];
const ingest = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const lines = raw.split("\n").filter(Boolean);
    const items = [];
    for (let i = 1; i + 1 < lines.length; i += 2) {
      try {
        items.push({ header: JSON.parse(lines[i]), payload: JSON.parse(lines[i + 1]) });
      } catch {
        // attachments / non-JSON payloads are not used here
      }
    }
    envelopes.push({ url: req.url, raw, header: JSON.parse(lines[0] ?? "{}"), items });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => ingest.listen(0, "127.0.0.1", resolve));
const ingestPort = ingest.address().port;
const DSN = `http://publickey@127.0.0.1:${ingestPort}/1`;

// ── API instances ───────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function bootApi(env) {
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    env: { ...process.env, SENTRY_DSN: "", SENTRY_ENVIRONMENT: "", RENDER_GIT_COMMIT: "", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => output.push(d.toString()));
  child.stderr.on("data", (d) => output.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`API exited early:\n${output.join("")}`);
    const ok = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
    if (ok) return { base, output, stop: () => new Promise((r) => { child.once("exit", r); child.kill(); }) };
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error(`API did not become healthy:\n${output.join("")}`);
}

function makeSession(base) {
  let cookie = "";
  const request = async (method, path, body, extraHeaders = {}) => {
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (res.headers.get("content-type") ?? "").includes("application/json") ? await res.json().catch(() => null) : null;
    return { status: res.status, data };
  };
  request.cookie = () => cookie;
  return request;
}

async function registerAndLogin(base, email) {
  const session = makeSession(base);
  const reg = await session("POST", "/auth/register", { name: "Error report probe", email, password: "password-123" });
  if (![200, 201].includes(reg.status)) throw new Error(`registration failed (${reg.status})`);
  fixtures.trackRegisteredUser();
  if (reg.data?.verificationToken) {
    const verify = await session("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
    if (verify.status !== 200) throw new Error(`verification failed (${verify.status})`);
    const login = await session("POST", "/auth/login", { email, password: "password-123" });
    if (login.status !== 200) throw new Error(`login failed (${login.status})`);
  }
  const me = await session("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;
  if (Number.isInteger(clientId)) fixtures.trackClient(clientId);
  return session;
}

async function productionWithoutDsn() {
  const api = await bootApi({ NODE_ENV: "production" });
  try {
    const ready = await fetch(`${api.base}/readyz`).then((r) => r.json());
    check("production without DSN: /readyz notes error reports are off",
      ready?.details?.errorReports?.configured === false, JSON.stringify(ready?.details ?? null));
    check("production without DSN: startup log says monitoring is disabled",
      api.output.join("").includes("Sentry monitoring is disabled: SENTRY_DSN is not configured"));
    check("production without DSN: nothing claims reports are configured",
      !api.output.join("").includes("error reports are configured"));
  } finally {
    await api.stop();
  }
  check("production without DSN: nothing was sent to Sentry", envelopes.length === 0, `${envelopes.length} envelopes`);
}

async function withDsn() {
  const operatorEmail = `error-ops-${runId}@test.local`;
  const api = await bootApi({
    NODE_ENV: "test",
    SENTRY_DSN: DSN,
    RENDER_GIT_COMMIT: "testcommit0123",
    PLATFORM_ADMIN_EMAILS: operatorEmail,
  });
  try {
    check("with DSN: startup log says reports are configured for environment \"test\"",
      api.output.join("").includes('Sentry error reports are configured (environment "test")'));

    const other = await registerAndLogin(api.base, `error-other-${runId}-${randomUUID()}@test.local`);
    const denied = await other("POST", "/admin/error-reports/test", {});
    check("test report: non-operator gets 403", denied.status === 403, `got ${denied.status}`);

    const operator = await registerAndLogin(api.base, operatorEmail);
    // The route is for ALPS's consultant sign-in; sign-up makes an Owner, so promote.
    promoteToConsultant(operatorEmail);
    const secretQuery = `token=${randomUUID()}`;
    const sent = await operator("POST", `/admin/error-reports/test?${secretQuery}`, { password: "hunter2-secret-body" }, {
      authorization: "Bearer bearer-secret-header",
      "x-csrf-token": "csrf-secret-header",
    });
    check("test report: operator gets 200", sent.status === 200, `got ${sent.status} ${JSON.stringify(sent.data)}`);
    const result = sent.data ?? {};
    check("test report: response says configured", result.configured === true, JSON.stringify(result));
    check("test report: Sentry accepted it", result.delivery?.outcome === "accepted" && result.delivery?.statusCode === 200, JSON.stringify(result.delivery));
    check("test report: response environment is NODE_ENV", result.environment === "test", result.environment);
    check("test report: response release is RENDER_GIT_COMMIT", result.release === "testcommit0123", result.release);

    const envelope = envelopes.find((e) => e.header.event_id === result.eventId);
    const event = envelope?.items.find((i) => i.header.type === "event")?.payload;
    check("ingest: received the test event", Boolean(event), `ids: ${envelopes.map((e) => e.header.event_id).join(",")}`);
    if (event) {
      check("event: environment tag", event.environment === "test", event.environment);
      check("event: release tag", event.release === "testcommit0123", event.release);
      check("event: test tag", event.tags?.test_report === "true", JSON.stringify(event.tags));
      check("event: error message", event.exception?.values?.[0]?.value === "ComplyTrack test error report (API)");
      check("event: has a stack trace", (event.exception?.values?.[0]?.stacktrace?.frames?.length ?? 0) > 0);
      check("event: request method kept", event.request?.method === "POST", JSON.stringify(event.request));
      check("event: request path kept without query",
        typeof event.request?.url === "string" && event.request.url.endsWith("/api/admin/error-reports/test"), event.request?.url);
      for (const key of ["headers", "cookies", "data", "query_string"]) {
        check(`event: request.${key} removed`, event.request?.[key] === undefined, JSON.stringify(event.request?.[key]));
      }
      check("event: no user email or IP", !event.user?.email && !event.user?.ip_address, JSON.stringify(event.user));
    }
    const sessionCookieValue = operator.cookie().split("=")[1] ?? "";
    for (const [label, secret] of [
      ["session cookie", sessionCookieValue],
      ["query token", secretQuery],
      ["request body", "hunter2-secret-body"],
      ["bearer header", "bearer-secret-header"],
      ["CSRF header", "csrf-secret-header"],
      ["operator email", operatorEmail],
    ]) {
      check(`nothing sent contains the ${label}`, secret.length > 0 && !envelopes.some((e) => e.raw.includes(secret)));
    }
  } finally {
    await api.stop();
  }
}

async function main() {
  console.log(`error-reports fixture run id: ${runId}`);
  try {
    await productionWithoutDsn();
    await withDsn();
  } catch (err) {
    failures.push(`suite aborted — ${err?.message ?? err}`);
    console.error("Test run aborted:", err?.message ?? err);
  } finally {
    ingest.close();
    try {
      await fixtures.cleanup();
    } catch (err) {
      failures.push(`fixture cleanup — ${err?.message ?? err}`);
    }
  }
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
