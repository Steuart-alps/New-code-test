// Proves per-run fixture cleanup removes only the current run's tenants.
//
// Runs inside tests/run-fresh-schema.sh (private initdb database and API):
//   1. A bystander run registers a tenant with audited FireTrack evidence.
//   2. A purge that names the bystander's client under another run id is
//      refused and deletes nothing.
//   3. module-routes and config-endpoints run concurrently with deliberate
//      failures (FIXTURE_PROBE_FAIL_AT) after writing audited records and,
//      for config, a consultant-created second client. Both must fail, clean
//      up their own tenants in finally, and leave the bystander untouched.
//   4. Audit-ledger guards are re-enabled afterwards and still block deletes.
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { purgeOwnedFixtures } from "./fixture-ownership.mjs";

const execFile = promisify(execFileCallback);
const BASE = process.env.API_BASE;
const DATABASE_URL = process.env.DATABASE_URL;
if (!BASE || !DATABASE_URL) {
  console.error("Run through tests/run-fresh-schema.sh: API_BASE and DATABASE_URL are required.");
  process.exit(1);
}

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function query(sql) {
  try {
    const { stdout } = await execFile("psql", ["-X", "-d", DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]);
    return stdout.trim();
  } catch (error) {
    // execFile errors include argv; never expose the connection string.
    const err = new Error(`fixture probe SQL failed: ${String(error.stderr ?? "").trim()}`);
    err.stderr = String(error.stderr ?? "");
    throw err;
  }
}
const count = async (sql) => Number(await query(sql));

function makeSession() {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (res.headers.get("content-type") ?? "").includes("application/json")
      ? await res.json().catch(() => null)
      : (await res.text().catch(() => null), null);
    return { status: res.status, data };
  };
}

async function registerTenant(runId) {
  const req = makeSession();
  const email = `bystander-${runId}@test.local`;
  const reg = await req("POST", "/auth/register", { name: "Bystander", email, password: "password-123" });
  if (![200, 201].includes(reg.status)) throw new Error(`bystander registration failed (${reg.status})`);
  if (reg.data?.verificationToken) {
    const verify = await req("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
    if (verify.status !== 200) throw new Error(`bystander verification failed (${verify.status})`);
    const login = await req("POST", "/auth/login", { email, password: "password-123" });
    if (login.status !== 200) throw new Error(`bystander login failed (${login.status})`);
  }
  const me = await req("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;
  if (!Number.isInteger(clientId)) throw new Error("bystander has no client");
  const record = await req("POST", "/fire-safety", {
    checkType: "alarm", checkDate: new Date().toISOString().slice(0, 10), result: "pass",
  });
  if (record.status !== 201) throw new Error(`bystander audited record failed (${record.status})`);
  return { clientId };
}

async function snapshot(clientId, runId) {
  return {
    users: await count(`SELECT count(*) FROM users WHERE position('${runId}' IN email) > 0`),
    client: await count(`SELECT count(*) FROM clients WHERE id = ${clientId}`),
    auditLog: await count(`SELECT count(*) FROM audit_log WHERE client_id = ${clientId}`),
    auditEvents: await count(`SELECT count(*) FROM audit_events WHERE client_id = ${clientId}`),
    fire: await count(`SELECT count(*) FROM fire_safety_checks WHERE client_id = ${clientId}`),
  };
}

function runSuite(file, runId, failAt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, TEST_RUN_ID: runId, FIXTURE_PROBE_FAIL_AT: failAt },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

const bystanderRunId = randomUUID();
let bystander;
try {
  bystander = await registerTenant(bystanderRunId);
  const before = await snapshot(bystander.clientId, bystanderRunId);
  check("setup: bystander has audited evidence",
    before.users === 1 && before.client === 1 && before.auditLog > 0 && before.auditEvents > 0 && before.fire === 1,
    JSON.stringify(before));

  // A wrong client id under another run id must be refused outright.
  let refusal = "";
  try {
    await purgeOwnedFixtures({ runId: randomUUID(), clientIds: [bystander.clientId], databaseUrl: DATABASE_URL });
  } catch (error) {
    refusal = String(error.message);
  }
  check("misdirected purge is refused", /not owned by run/.test(refusal), refusal || "purge succeeded");
  check("misdirected purge deletes nothing",
    JSON.stringify(await snapshot(bystander.clientId, bystanderRunId)) === JSON.stringify(before));

  const totals = async () => ({
    clients: await count("SELECT count(*) FROM clients"),
    users: await count("SELECT count(*) FROM users"),
    auditLog: await count("SELECT count(*) FROM audit_log"),
  });
  const totalsBefore = await totals();

  // Two suites fail deliberately at the same time, after writing audited rows.
  const moduleRunId = randomUUID();
  const configRunId = randomUUID();
  const [moduleRun, configRun] = await Promise.all([
    runSuite("tests/module-routes.mjs", moduleRunId, "after-fire-safety"),
    runSuite("tests/config-endpoints.mjs", configRunId, "after-record-validation"),
  ]);
  for (const [name, run, runId, clients] of [
    ["module-routes", moduleRun, moduleRunId, 1],
    ["config-endpoints", configRun, configRunId, 2],
  ]) {
    console.log(`${name}: ${run.output.match(/fixture-purge run=[^\n]*/)?.[0] ?? "no cleanup summary"}`);
    check(`${name}: deliberate failure exits non-zero`, run.code === 1, `exit ${run.code}`);
    check(`${name}: failure was the injected one`, run.output.includes("deliberate"), run.output.slice(-400));
    check(`${name}: finally cleanup removed its own tenants`,
      new RegExp(`fixture-purge run=${runId} users=\\d+ clients=${clients} rows=\\d+`).test(run.output),
      run.output.slice(-600));
    check(`${name}: no users remain for the run`,
      (await count(`SELECT count(*) FROM users WHERE position('${runId}' IN email) > 0`)) === 0);
  }
  check("config-endpoints: consultant-created client B is removed",
    (await count(`SELECT count(*) FROM clients WHERE slug LIKE '%${configRunId}%'`)) === 0);
  const totalsAfter = await totals();
  check("failed runs leave no clients, users or audit rows behind",
    JSON.stringify(totalsAfter) === JSON.stringify(totalsBefore),
    `before ${JSON.stringify(totalsBefore)} after ${JSON.stringify(totalsAfter)}`);
  check("concurrent cleanups leave the bystander untouched",
    JSON.stringify(await snapshot(bystander.clientId, bystanderRunId)) === JSON.stringify(before));

  const triggerStates = await query(`SELECT string_agg(DISTINCT tgenabled::text, ',') FROM pg_trigger
    WHERE tgname IN ('audit_log_immutable', 'audit_events_immutable', 'compliance_audit_log')`);
  check("audit guards are re-enabled after cleanup", triggerStates === "O", `states=${triggerStates}`);
  let guardError = "";
  try {
    await query(`DELETE FROM audit_log WHERE client_id = ${bystander.clientId}`);
  } catch (error) {
    guardError = error.stderr ?? "";
  }
  check("audit_log is still append-only outside fixture cleanup", /append-only/.test(guardError), guardError);
} catch (error) {
  failures.push(`probe aborted — ${error?.message ?? error}`);
} finally {
  try {
    const summary = await purgeOwnedFixtures({
      runId: bystanderRunId,
      clientIds: bystander ? [bystander.clientId] : [],
      minUsers: bystander ? 1 : 0,
      databaseUrl: DATABASE_URL,
    });
    check("bystander cleanup succeeds", summary.includes(`run=${bystanderRunId}`), summary);
    if (bystander) {
      check("bystander tenant is removed by its own run",
        (await count(`SELECT count(*) FROM clients WHERE id = ${bystander.clientId}`)) === 0);
    }
  } catch (error) {
    failures.push(`bystander cleanup — ${error?.message ?? error}`);
  }
}

console.log(`\n${passed} checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
