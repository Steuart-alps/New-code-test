// Manager-issued per-client discount code tests.
//
// Verifies:
//   - Consultant (manager) can generate + replace a client's discount code
//   - Raw code is returned only at issue time; status endpoint exposes only
//     lifecycle + a 4-char hint
//   - client_admin / staff / viewer users cannot read or manage codes
//   - Cross-tenant access via ?clientId is rejected
//   - Checkout rejects wrong codes, replaced codes, and other clients' codes
//
// Usage: node tests/discount-codes.mjs
// Exits 0 when all checks pass, 1 otherwise.

const BASE = process.env.API_BASE || "http://localhost:8080/api";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function makeSession() {
  let cookie = "";
  return async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) data = await res.json().catch(() => null);
    else await res.text().catch(() => null);
    return { status: res.status, data };
  };
}

async function registerAccount(label, ts) {
  const session = makeSession();
  const email = `${label}-${ts}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = "password-123";
  const reg = await session("POST", "/auth/register", { name: `${label} account`, email, password });
  if (![200, 201].includes(reg.status)) {
    console.error(`FATAL: registration failed for ${label}`, reg.status, reg.data);
    process.exit(1);
  }
  if (reg.data?.verificationToken) {
    const verify = await session("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
    if (verify.status !== 200) {
      console.error(`FATAL: verification failed for ${label}`, verify.status, verify.data);
      process.exit(1);
    }
    const login = await session("POST", "/auth/login", { email, password });
    if (login.status !== 200) {
      console.error(`FATAL: login failed for ${label}`, login.status, login.data);
      process.exit(1);
    }
  }
  const me = await session("GET", "/auth/me");
  const user = me.data?.user ?? me.data;
  const clientId = user?.clientId;
  if (!Number.isInteger(clientId)) {
    console.error(`FATAL: no clientId for ${label}`, me.status, me.data);
    process.exit(1);
  }
  return { session, clientId, email };
}

async function createAndLogin(admin, clientId, role, label, ts) {
  const email = `${label}-${ts}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = "password-456";
  const created = await admin("POST", "/users", { name: label, email, password, role, clientId });
  if (![200, 201].includes(created.status)) {
    console.error(`FATAL: could not create ${role} sub-user`, created.status, created.data);
    process.exit(1);
  }
  const session = makeSession();
  const login = await session("POST", "/auth/login", { email, password });
  if (login.status !== 200) {
    console.error(`FATAL: sub-user login failed for ${role}`, login.status, login.data);
    process.exit(1);
  }
  return session;
}

const CODE_RE = /^ALPS-[2-9A-HJKMNP-TV-Z]{4}(-[2-9A-HJKMNP-TV-Z]{4}){3}$/;

async function main() {
  const ts = Date.now();
  const a = await registerAccount("discount-a", ts);
  const b = await registerAccount("discount-b", ts);

  console.log("\n── Manager issue / status / replace ──");

  // Initial status: no code
  const none = await a.session("GET", "/billing/discount-code");
  check("status: 200 before issue", none.status === 200, `got ${none.status}`);
  check("status: none before issue", none.data?.status === "none", `got ${none.data?.status}`);

  // Generate
  const gen = await a.session("POST", "/billing/discount-code");
  check("issue: 201", gen.status === 201, `got ${gen.status}`);
  const code1 = gen.data?.code;
  check("issue: code format", typeof code1 === "string" && CODE_RE.test(code1), `got ${code1}`);
  check("issue: hint is last 4", gen.data?.hint === code1?.slice(-4), `got ${gen.data?.hint}`);

  // Status after issue: available, hint only, never the raw code
  const st = await a.session("GET", "/billing/discount-code");
  check("status: available after issue", st.data?.status === "available", `got ${st.data?.status}`);
  check("status: hint matches", st.data?.hint === code1.slice(-4), `got ${st.data?.hint}`);
  check("status: raw code never exposed", !JSON.stringify(st.data).includes(code1), "full code leaked in status");

  // Replace: new code, old one stops working
  const gen2 = await a.session("POST", "/billing/discount-code");
  check("replace: 201", gen2.status === 201, `got ${gen2.status}`);
  const code2 = gen2.data?.code;
  check("replace: different code", typeof code2 === "string" && code2 !== code1, "code unchanged");

  console.log("\n── Checkout validation ──");

  // Wrong code → 400 (before any Stripe call)
  const wrong = await a.session("POST", "/billing/checkout", { discountCode: "ALPS-XXXX-XXXX-XXXX-XXXX" });
  check("checkout: wrong code → 400", wrong.status === 400, `got ${wrong.status}`);

  // Replaced (old) code → 400
  const replaced = await a.session("POST", "/billing/checkout", { discountCode: code1 });
  check("checkout: replaced code → 400", replaced.status === 400, `got ${replaced.status}`);

  // Another client's valid code → 400 for B
  const cross = await b.session("POST", "/billing/checkout", { discountCode: code2 });
  check("checkout: other client's code → 400", cross.status === 400, `got ${cross.status}`);

  // Retired shared code no longer accepted
  const legacy = await a.session("POST", "/billing/checkout", { discountCode: "ALPS50" });
  check("checkout: legacy ALPS50 → 400", legacy.status === 400, `got ${legacy.status}`);

  console.log("\n── Authorization boundaries ──");

  // Client-side roles cannot read or manage codes
  for (const role of ["client_admin", "client_staff", "client_viewer"]) {
    const sub = await createAndLogin(a.session, a.clientId, role, `discount-${role}`, ts);
    const get = await sub("GET", "/billing/discount-code");
    check(`${role}: GET blocked`, get.status === 403, `got ${get.status}`);
    const post = await sub("POST", "/billing/discount-code");
    check(`${role}: POST blocked`, post.status === 403, `got ${post.status}`);
  }

  // Cross-tenant: consultant B cannot touch client A's code
  const crossGet = await b.session("GET", `/billing/discount-code?clientId=${a.clientId}`);
  check("cross-tenant: GET blocked", crossGet.status === 403, `got ${crossGet.status}`);
  const crossPost = await b.session("POST", `/billing/discount-code?clientId=${a.clientId}`);
  check("cross-tenant: POST blocked", crossPost.status === 403, `got ${crossPost.status}`);

  // Unauthenticated
  const anon = makeSession();
  const anonGet = await anon("GET", "/billing/discount-code");
  check("anonymous: GET blocked", anonGet.status === 401, `got ${anonGet.status}`);

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
