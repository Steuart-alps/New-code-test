// Self-contained test for the sign-in rate limiter (src/lib/loginRateLimit.ts).
//
// Boots a tiny in-process express app that mounts the REAL limiter middleware
// in front of stub credential routes, then drives it over HTTP to verify:
//   1. per-email cap: 5 failed (401) attempts -> 6th is 429 with Retry-After
//   2. a successful (2xx) login clears the email counter
//   3. per-IP cap is higher than per-email (spraying many emails from one IP
//      keeps returning 401 well past the per-email cap, until the IP cap)
//   4. reset-password limiter counts 400 (invalid-token guesses) as failures
//
// No database is required — the limiter is pure IP/email counting.
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

const { loginRateLimit, makeLoginRateLimit, _resetLoginRateLimit } = await import(LIMITER_MODULE);

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

// Stub reset-password: 400 for an invalid token (mirrors real endpoint).
const resetLimiter = makeLoginRateLimit({ failureStatuses: [400, 401] });
app.post("/auth/reset-password", resetLimiter, (req, res) => {
  if (req.body?.token === "valid") res.json({ ok: true });
  else res.status(400).json({ error: "invalid token" });
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
  // 1. per-email cap ---------------------------------------------------------
  _resetLoginRateLimit();
  const ip1 = "203.0.113.10";
  let last;
  for (let i = 0; i < 5; i++) {
    last = await post("/auth/login", { email: "victim@example.com", password: "wrong" }, ip1);
  }
  check("first 5 wrong logins return 401", last.status === 401, `got ${last.status}`);
  const blocked = await post("/auth/login", { email: "victim@example.com", password: "wrong" }, ip1);
  check("6th attempt is 429", blocked.status === 429, `got ${blocked.status}`);
  check("429 sets Retry-After header", Number(blocked.retryAfter) > 0, `retry-after=${blocked.retryAfter}`);
  check("429 body has retryAfterSeconds", blocked.body?.retryAfterSeconds > 0);
  check("429 body has clear message", typeof blocked.body?.error === "string" && blocked.body.error.length > 0);
  // even a correct password is blocked once over the cap
  const blockedCorrect = await post("/auth/login", { email: "victim@example.com", password: "correct" }, ip1);
  check("correct password also blocked while limited", blockedCorrect.status === 429, `got ${blockedCorrect.status}`);

  // 2. success clears the email counter --------------------------------------
  _resetLoginRateLimit();
  const ip2 = "203.0.113.20";
  for (let i = 0; i < 4; i++) await post("/auth/login", { email: "user2@example.com", password: "wrong" }, ip2);
  const ok = await post("/auth/login", { email: "user2@example.com", password: "correct" }, ip2);
  check("successful login returns 2xx", ok.status >= 200 && ok.status < 300, `got ${ok.status}`);
  // after reset, another full run of wrong attempts must still get 5 x 401
  let afterReset;
  for (let i = 0; i < 5; i++) {
    afterReset = await post("/auth/login", { email: "user2@example.com", password: "wrong" }, ip2);
  }
  check("email counter reset after success (5 fresh 401s)", afterReset.status === 401, `got ${afterReset.status}`);

  // 3. per-IP cap is higher than per-email -----------------------------------
  _resetLoginRateLimit();
  const ip3 = "203.0.113.30";
  // Spray 10 distinct emails once each from one IP: each email is under its own
  // cap (1 < 5) so all should be 401, proving the IP cap is > per-email cap.
  let sprayBlocked = false;
  for (let i = 0; i < 10; i++) {
    const r = await post("/auth/login", { email: `spray${i}@example.com`, password: "wrong" }, ip3);
    if (r.status === 429) { sprayBlocked = true; break; }
  }
  check("per-IP cap higher than per-email (10 unique emails not blocked)", !sprayBlocked);
  // Keep spraying from the same IP; eventually the higher IP cap trips.
  let ipTripped = false;
  for (let i = 10; i < 60; i++) {
    const r = await post("/auth/login", { email: `spray${i}@example.com`, password: "wrong" }, ip3);
    if (r.status === 429) { ipTripped = true; break; }
  }
  check("per-IP cap eventually trips on sustained spraying", ipTripped);

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
  for (let i = 1; i < 60; i++) {
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
