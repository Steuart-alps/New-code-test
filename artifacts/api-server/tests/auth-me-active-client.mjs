// /auth/me reports the modules and billing lock of the business being viewed.
//
// A consultant can open a business other than their own. The web app hides
// and locks modules from /auth/me's `services`, so it must describe the open
// business (?clientId=), not the consultant's own: otherwise a consultant
// whose own business pays for a few modules opens a free business (no trial
// end, every module included) and finds FireTrack locked, with "Enable" only
// leading to a Settings page that says every module is already free.
//
// Rules protected here:
//   - without ?clientId= it is the signed-in user's own business, as before;
//   - with ?clientId= of a business a consultant looks after, that business's
//     modules and billing lock;
//   - a business the user may not open is refused (403), never described.
//
// Usage: bash tests/run-fresh-schema.sh tests/auth-me-active-client.mjs
// (disposable database only).
import { execFileSync } from "node:child_process";
import { promoteToConsultant } from "./consultant-account.mjs";

if (process.env.FRESH_SCHEMA_TEST !== "1" || !process.env.DATABASE_URL || !process.env.API_BASE) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/auth-me-active-client.mjs (disposable database only)");
}
const BASE = process.env.API_BASE;

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}${detail ? `: ${detail}` : ""}`); console.error(`FAIL: ${name}${detail ? `: ${detail}` : ""}`); }
}
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function sql(text) {
  execFileSync("psql", [process.env.DATABASE_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: text, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"],
  });
}

function session() {
  let cookie = "";
  return async (method, route, body) => {
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function signUp(label, stamp) {
  const user = session();
  const email = `auth-me-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `Auth me ${label}`, email, password: "password-123" });
  if (![200, 201].includes(registered.status)) throw new Error(`register ${label}: ${registered.status} ${JSON.stringify(registered.data)}`);
  await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  return { user, email };
}

async function login(account) {
  const result = await account.user("POST", "/auth/login", { email: account.email, password: "password-123" });
  if (result.status !== 200) throw new Error(`login ${account.email}: ${result.status} ${JSON.stringify(result.data)}`);
  const me = await account.user("GET", "/auth/me");
  const clientId = me.data?.user?.clientId;
  if (!Number.isSafeInteger(clientId)) throw new Error(`no business for ${account.email}`);
  return clientId;
}

try {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const consultant = await signUp("consultant", stamp);
  const owner = await signUp("owner", stamp);
  const outsider = await signUp("outsider", stamp);
  promoteToConsultant(consultant.email);
  const homeId = await login(consultant);
  const freeId = await login(owner);
  const outsiderId = await login(outsider);

  // The consultant's own business: trial over, nothing paid, so core only and
  // locked. The other: set up by ALPS, no trial end, every module free.
  sql(`
    UPDATE clients SET trial_ends_at = now() - interval '2 days' WHERE id = ${homeId};
    UPDATE clients SET trial_ends_at = NULL WHERE id = ${freeId};
    INSERT INTO consultant_clients (user_id, client_id)
      SELECT id, ${freeId} FROM users WHERE lower(email) = lower('${consultant.email}')
      ON CONFLICT DO NOTHING;
  `);

  const own = await consultant.user("GET", "/auth/me");
  same("own business without clientId: status", own.status, 200);
  same("own business without clientId: core only", own.data?.services, ["core"]);
  same("own business without clientId: locked", own.data?.billingLocked, true);

  const viewing = await consultant.user("GET", `/auth/me?clientId=${freeId}`);
  same("open free business: status", viewing.status, 200);
  same("open free business: every module", viewing.data?.services, "all");
  same("open free business: not locked", viewing.data?.billingLocked, false);
  same("open free business: still the consultant's own account", viewing.data?.user?.clientId, homeId);

  const ownExplicit = await consultant.user("GET", `/auth/me?clientId=${homeId}`);
  same("own business by clientId: core only", ownExplicit.data?.services, ["core"]);

  const notLinked = await consultant.user("GET", `/auth/me?clientId=${outsiderId}`);
  same("business the consultant does not look after: refused", notLinked.status, 403);
  check("business the consultant does not look after: not described", notLinked.data?.services === undefined);

  const ownerPeek = await owner.user("GET", `/auth/me?clientId=${homeId}`);
  same("owner asking about another business: refused", ownerPeek.status, 403);
  const ownerOwn = await owner.user("GET", "/auth/me");
  same("owner's own free business: every module", ownerOwn.data?.services, "all");
} catch (err) {
  failures.push(`unexpected error: ${err?.stack ?? err}`);
  console.error(err);
}

console.log(`auth-me-active-client: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
