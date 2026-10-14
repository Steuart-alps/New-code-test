// End-to-end CSRF enforcement against a real API process.
//
// The other integration suites run with NODE_ENV=test, which skips the CSRF
// middleware, so a web client that stopped sending X-CSRF-Token would still
// pass them. This suite runs against an API booted with ENFORCE_CSRF=1 and
// checks the production contract:
//   - a cookie-session POST without X-CSRF-Token is refused (403) and writes
//     nothing;
//   - the same POST with the token from GET /api/auth/csrf-token succeeds;
//   - a bearer-token (mobile) POST needs no CSRF token.
//
// Usage: pnpm run test:csrf-enforced:ci (boots a private API with
// ENFORCE_CSRF=1). Every client and user this run registers is removed in a
// finally block; see tests/fixture-ownership.mjs.
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";

const runId = resolveRunId();
const fixtures = createFixtureOwnership({ runId, suite: "csrf-enforced" });

const BASE = process.env.API_BASE;
if (!BASE) {
  console.error("API_BASE is required (use `pnpm run test:csrf-enforced:ci` to boot a private API).");
  process.exit(1);
}
const API_ORIGIN = new URL(BASE).origin;

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

async function send(method, path, { cookie, headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) data = await res.json().catch(() => null);
  else await res.text().catch(() => null);
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
}

function fireCheck(notes) {
  return {
    checkType: "alarm",
    checkDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    result: "pass",
    notes,
    performedBy: "CSRF Test",
  };
}

async function fireCheckNotes(cookie) {
  const list = await send("GET", "/fire-safety", { cookie });
  if (list.status !== 200 || !Array.isArray(list.data)) {
    throw new Error(`could not list fire-safety records (${list.status})`);
  }
  return list.data.map((r) => r.notes);
}

async function runSuite() {
  // ── Fixture: a verified, cookie-authenticated account ──────────────────
  const email = `csrf-${runId}@test.local`;
  const password = "password-123";
  const reg = await send("POST", "/auth/register", {
    body: { name: "CSRF Test Account", email, password },
  });
  if (![200, 201].includes(reg.status)) throw new Error(`FATAL: registration failed (${reg.status})`);
  fixtures.trackRegisteredUser();
  if (reg.data?.verificationToken) {
    const verified = await send("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
    if (verified.status !== 200) throw new Error(`FATAL: email verification failed (${verified.status})`);
  }
  // Login is exempt from CSRF (it establishes the session).
  const login = await send("POST", "/auth/login", {
    body: { email, password },
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  if (login.status !== 200 || !login.setCookie) throw new Error(`FATAL: login failed (${login.status})`);
  const cookie = login.setCookie.split(";")[0];

  const me = await send("GET", "/auth/me", { cookie });
  const clientId = (me.data?.user ?? me.data)?.clientId;
  if (!Number.isInteger(clientId)) throw new Error(`FATAL: no client for the registered account (${me.status})`);
  fixtures.trackClient(clientId);

  // ── Cookie session without the token: refused, nothing written ─────────
  const sameOrigin = { "Sec-Fetch-Site": "same-origin", Origin: API_ORIGIN };
  const missing = await send("POST", "/fire-safety", {
    cookie, headers: sameOrigin, body: fireCheck("csrf-missing"),
  });
  check("cookie POST without X-CSRF-Token is refused", missing.status === 403, `got ${missing.status}`);
  check("refusal names the CSRF check", missing.data?.error === "CSRF validation failed", JSON.stringify(missing.data));

  const wrong = await send("POST", "/fire-safety", {
    cookie, headers: { ...sameOrigin, "X-CSRF-Token": "not-the-session-token" }, body: fireCheck("csrf-wrong"),
  });
  check("cookie POST with a wrong X-CSRF-Token is refused", wrong.status === 403, `got ${wrong.status}`);

  // ── Same POST with the session's token: accepted ───────────────────────
  const tokenRes = await send("GET", "/auth/csrf-token", { cookie });
  const token = tokenRes.data?.token;
  check("GET /auth/csrf-token returns a token", tokenRes.status === 200 && typeof token === "string" && token.length >= 32,
    `status ${tokenRes.status}`);

  const accepted = await send("POST", "/fire-safety", {
    cookie, headers: { ...sameOrigin, "X-CSRF-Token": token }, body: fireCheck("csrf-with-token"),
  });
  check("cookie POST with the session's X-CSRF-Token succeeds", accepted.status === 201, `got ${accepted.status}`);

  // Fetch Metadata alone (no Origin) is how some browsers send same-origin requests.
  const metadataOnly = await send("POST", "/fire-safety", {
    cookie, headers: { "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": token }, body: fireCheck("csrf-metadata-only"),
  });
  check("same-origin Fetch Metadata with the token succeeds", metadataOnly.status === 201, `got ${metadataOnly.status}`);

  const crossSite = await send("POST", "/fire-safety", {
    cookie, headers: { "Sec-Fetch-Site": "cross-site", "X-CSRF-Token": token }, body: fireCheck("csrf-cross-site"),
  });
  check("cross-site POST is refused even with the token", crossSite.status === 403, `got ${crossSite.status}`);

  const notes = await fireCheckNotes(cookie);
  check("refused POSTs wrote nothing",
    !notes.includes("csrf-missing") && !notes.includes("csrf-wrong") && !notes.includes("csrf-cross-site"),
    JSON.stringify(notes));
  check("accepted POSTs were stored", notes.includes("csrf-with-token") && notes.includes("csrf-metadata-only"),
    JSON.stringify(notes));

  // ── Bearer (mobile) requests are exempt ────────────────────────────────
  const mobile = await send("POST", "/auth/mobile-login", { body: { email, password } });
  const bearer = mobile.data?.token;
  check("mobile login issues a bearer token", mobile.status === 200 && typeof bearer === "string",
    `status ${mobile.status}`);
  const bearerPost = await send("POST", "/fire-safety", {
    headers: { Authorization: `Bearer ${bearer}` }, body: fireCheck("csrf-bearer"),
  });
  check("bearer POST without X-CSRF-Token succeeds", bearerPost.status === 201, `got ${bearerPost.status}`);
  check("bearer POST was stored", (await fireCheckNotes(cookie)).includes("csrf-bearer"));
}

async function main() {
  console.log(`csrf-enforced fixture run id: ${runId}`);
  try {
    await runSuite();
  } catch (err) {
    failures.push(`suite aborted — ${err?.message ?? err}`);
    console.error("Test run aborted:", err?.message ?? err);
  } finally {
    try {
      await fixtures.cleanup();
    } catch (err) {
      failures.push(`fixture cleanup — ${err?.message ?? err}`);
      console.error(`FAIL: fixture cleanup — ${err?.message ?? err}`);
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
