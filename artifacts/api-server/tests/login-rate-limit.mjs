// Self-contained test for the sign-in rate limiter (src/lib/loginRateLimit.ts).
//
// Boots a tiny in-process express app that mounts the REAL limiter middleware
// in front of stub credential routes, then drives it over HTTP to verify:
//   1. login allows 10 attempts per IP per 15 minutes, then returns 429
//   2. successful attempts still consume quota
//   3. registration allows 5 attempts per IP per hour, independently of login
//   4. reset-password limiter counts 400 (invalid-token guesses) as failures
//
// No database is required — the limiter is pure IP/email counting. The real
// PostgreSQL shared store is covered by tests/login-rate-limit-postgres.mjs
// (pnpm run test:login-rate-limit-postgres).
//
// The runner (run-login-rate-limit.sh) esbuild-bundles the TS middleware to a
// temp .mjs and points LIMITER_MODULE at it before invoking this file.
//
// Exits 0 when every check passes, 1 otherwise.

import express from "express";
import http from "node:http";

const LIMITER_MODULE = process.env.LIMITER_MODULE;
if (!LIMITER_MODULE) {
  console.error("LIMITER_MODULE env var not set (run via tests/run-login-rate-limit.sh)");
  process.exit(1);
}

const { makeLoginRateLimit, _resetLoginRateLimit } = await import(LIMITER_MODULE);
const loginRateLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  namespace: "login",
});
const registrationRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  namespace: "register",
});

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── fixture app ──────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(express.json());

// Stub login: 401 unless password === "correct".
app.post("/auth/login", loginRateLimit, (req, res) => {
  if (req.body?.password === "correct") res.json({ ok: true });
  else res.status(401).json({ error: "bad" });
});

app.post("/auth/register", registrationRateLimit, (_req, res) => {
  res.status(201).json({ ok: true });
});

// Stub reset-password: 400 for an invalid token (mirrors real endpoint).
const resetLimiter = makeLoginRateLimit({ failureStatuses: [400, 401] });
app.post("/auth/reset-password", resetLimiter, (req, res) => {
  if (req.body?.token === "valid") res.json({ ok: true });
  else res.status(400).json({ error: "invalid token" });
});

// Model two API instances using separate middleware objects and one shared
// atomic store. This exercises the production store contract without requiring
// a database in the limiter unit suite.
const sharedEntries = new Map();
const sharedCalls = [];
const sharedStore = {
  async consume(key, windowMs, max) {
    sharedCalls.push({ key, windowMs, max });
    const now = Date.now();
    let entry = sharedEntries.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      sharedEntries.set(key, entry);
    }
    entry.count = Math.min(entry.count + 1, max + 1);
    return {
      count: entry.count,
      retryAfterSeconds: Math.max(0, Math.ceil((entry.resetAt - now) / 1000)),
    };
  },
};
const nodeALoginLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000, max: 10, namespace: "login", store: sharedStore,
});
const nodeBLoginLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000, max: 10, namespace: "login", store: sharedStore,
});
const nodeARegistrationLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000, max: 5, namespace: "register", store: sharedStore,
});
const nodeBRegistrationLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000, max: 5, namespace: "register", store: sharedStore,
});
app.post("/node-a/auth/login", nodeALoginLimit, (_req, res) => res.status(401).json({ error: "bad" }));
app.post("/node-b/auth/login", nodeBLoginLimit, (_req, res) => res.status(401).json({ error: "bad" }));
app.post("/node-a/auth/register", nodeARegistrationLimit, (_req, res) => res.status(201).json({ ok: true }));
app.post("/node-b/auth/register", nodeBRegistrationLimit, (_req, res) => res.status(201).json({ ok: true }));

const failingStoreLimit = makeLoginRateLimit({
  namespace: "login",
  store: { async consume() { throw new Error("controlled shared-store outage"); } },
});
const missingStoreLimit = makeLoginRateLimit({
  namespace: "login",
  requireStore: true,
});
let unavailableHandlerCalls = 0;
app.post("/auth/shared-store-down", failingStoreLimit, (_req, res) => {
  unavailableHandlerCalls++;
  res.status(401).json({ error: "must not reach credentials" });
});
app.post("/auth/shared-store-missing", missingStoreLimit, (_req, res) => {
  unavailableHandlerCalls++;
  res.status(401).json({ error: "must not reach credentials" });
});

const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

function post(path, body, xff) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          ...(xff ? { "x-forwarded-for": xff } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, retryAfter: res.headers["retry-after"], body: raw ? JSON.parse(raw) : null }),
        );
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

try {
  // 1. login cap -------------------------------------------------------------
  _resetLoginRateLimit();
  const ip1 = "203.0.113.10";
  let last;
  for (let i = 0; i < 10; i++) {
    last = await post("/auth/login", { email: "victim@example.com", password: "wrong" }, ip1);
  }
  check("first 10 logins return 401", last.status === 401, `got ${last.status}`);
  const blocked = await post("/auth/login", { email: "victim@example.com", password: "wrong" }, ip1);
  check("11th attempt is 429", blocked.status === 429, `got ${blocked.status}`);
  check("429 sets Retry-After header", Number(blocked.retryAfter) > 0, `retry-after=${blocked.retryAfter}`);
  check("429 body has retryAfterSeconds", blocked.body?.retryAfterSeconds > 0);
  check("429 body has clear message", typeof blocked.body?.error === "string" && blocked.body.error.length > 0);
  // even a correct password is blocked once over the cap
  const blockedCorrect = await post("/auth/login", { email: "victim@example.com", password: "correct" }, ip1);
  check("correct password also blocked while limited", blockedCorrect.status === 429, `got ${blockedCorrect.status}`);

  // 2. all attempts consume quota --------------------------------------------
  _resetLoginRateLimit();
  const ip2 = "203.0.113.20";
  for (let i = 0; i < 9; i++) await post("/auth/login", { email: "user2@example.com", password: "wrong" }, ip2);
  const ok = await post("/auth/login", { email: "user2@example.com", password: "correct" }, ip2);
  check("successful login returns 2xx", ok.status >= 200 && ok.status < 300, `got ${ok.status}`);
  const afterSuccess = await post("/auth/login", { email: "user2@example.com", password: "wrong" }, ip2);
  check("successful login still consumes quota", afterSuccess.status === 429, `got ${afterSuccess.status}`);

  // 3. registration cap and independent namespace ---------------------------
  _resetLoginRateLimit();
  const ip3 = "203.0.113.30";
  let fifthRegistration;
  for (let i = 0; i < 5; i++) {
    fifthRegistration = await post("/auth/register", { email: `new${i}@example.com` }, ip3);
  }
  check("first 5 registrations are allowed", fifthRegistration.status === 201, `got ${fifthRegistration.status}`);
  const blockedRegistration = await post("/auth/register", { email: "new5@example.com" }, ip3);
  check("6th registration is 429", blockedRegistration.status === 429, `got ${blockedRegistration.status}`);
  check("registration 429 sets Retry-After", Number(blockedRegistration.retryAfter) > 0);
  const independentLogin = await post("/auth/login", { email: "user3@example.com", password: "wrong" }, ip3);
  check("registration quota does not consume login quota", independentLogin.status === 401, `got ${independentLogin.status}`);

  // 4. separate API instances share the same login and registration buckets --
  _resetLoginRateLimit();
  const sharedIp = "203.0.113.55";
  for (let i = 0; i < 5; i++) {
    await post("/node-a/auth/login", { password: "wrong" }, sharedIp);
    await post("/node-b/auth/login", { password: "wrong" }, sharedIp);
  }
  const sharedLoginBlocked = await post("/node-a/auth/login", { password: "wrong" }, sharedIp);
  check("login attempts across two instances exhaust one shared quota", sharedLoginBlocked.status === 429);
  check("shared login store receives the 15-minute window",
    sharedCalls.some((call) => call.key.startsWith("login:") && call.windowMs === 15 * 60 * 1000 && call.max === 10));

  _resetLoginRateLimit();
  for (let i = 0; i < 3; i++) await post("/node-a/auth/register", {}, sharedIp);
  for (let i = 0; i < 2; i++) await post("/node-b/auth/register", {}, sharedIp);
  const sharedRegistrationBlocked = await post("/node-b/auth/register", {}, sharedIp);
  check("registration attempts across two instances exhaust one shared quota", sharedRegistrationBlocked.status === 429);
  check("shared registration store receives the one-hour window",
    sharedCalls.some((call) => call.key.startsWith("register:") && call.windowMs === 60 * 60 * 1000 && call.max === 5));

  // Shared storage failures deny requests explicitly; credentials/registration
  // never run against a silently unprotected in-memory fallback.
  const sharedStoreUnavailable = await post("/auth/shared-store-down", {}, "203.0.113.56");
  check("shared store outage returns 503", sharedStoreUnavailable.status === 503);
  check("shared store outage does not call credential handler", unavailableHandlerCalls === 0);
  const sharedStoreUnconfigured = await post("/auth/shared-store-missing", {}, "203.0.113.57");
  check("required but unconfigured store returns 503", sharedStoreUnconfigured.status === 503);
  check("missing store does not call credential handler", unavailableHandlerCalls === 0);

  // 4. reset-password counts 400 (invalid token guesses) ---------------------
  // reset-password submits token+password (no email), so only the per-IP cap
  // guards it. Invalid-token guesses return 400, which this limiter counts as a
  // failure; after the IP cap is exceeded, further guesses are 429.
  _resetLoginRateLimit();
  const ip4 = "203.0.113.40";
  const firstReset = await post("/auth/reset-password", { token: "guess-0", password: "longenough" }, ip4);
  check("reset-password invalid token returns 400", firstReset.status === 400, `got ${firstReset.status}`);
  let resetTripped = false;
  let resetRetryAfter;
  for (let i = 1; i < 20; i++) {
    const r = await post("/auth/reset-password", { token: `guess-${i}`, password: "longenough" }, ip4);
    if (r.status === 429) { resetTripped = true; resetRetryAfter = r.retryAfter; break; }
  }
  check("reset-password token guessing trips per-IP cap (429)", resetTripped);
  check("reset-password 429 has Retry-After", Number(resetRetryAfter) > 0);
} finally {
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
process.exit(0);
