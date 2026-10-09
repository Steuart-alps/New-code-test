// E2E regression test for non-blocking self-registration welcome email delivery.
// Usage: node tests/welcome-email.mjs (API must be running on API_BASE)
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const CAPTURE_PATH = process.env.TEST_EMAIL_CAPTURE_PATH;
const SCENARIO = process.env.TEST_EMAIL_SCENARIO || "success";
const DELAY_MS = Number(process.env.TEST_EMAIL_DELAY_MS ?? 2500);

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function makeSession() {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

function capturedEmails() {
  if (!CAPTURE_PATH || !existsSync(CAPTURE_PATH)) return [];
  const raw = readFileSync(CAPTURE_PATH, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

function publicAppUrl() {
  const explicit = process.env.PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (explicit) return explicit;
  // Mirrors getPublicAppUrl() in src/lib/email.ts.
  const render = process.env.RENDER_EXTERNAL_URL?.replace(/\/+$/, "");
  return render || "http://localhost:5173";
}

async function main() {
  const ts = Date.now();
  const email = `welcome-email-${SCENARIO}-${ts}@test.local`;
  const name = `Welcome ${SCENARIO} User`;
  const session = makeSession();
  const startedAt = performance.now();
  const response = await session("POST", "/auth/register", {
    email,
    password: "welcome-password-123",
    name,
  });
  const elapsedMs = performance.now() - startedAt;

  check("registration succeeds", response.status === 200, `got ${response.status}`);
  check("registration returns email verification state", response.data?.requiresEmailVerification === true);
  check("registration returns a test verification token", typeof response.data?.verificationToken === "string");

  if (SCENARIO === "delay") {
    check(
      "registration does not wait for delayed email delivery",
      elapsedMs < DELAY_MS / 2,
      `${Math.round(elapsedMs)}ms response for ${DELAY_MS}ms email delay`,
    );
  }

  if (SCENARIO === "success") {
    const invitation = capturedEmails().find((entry) => entry.to === email);
    const appUrl = publicAppUrl();
    check("welcome email is sent to the new account", !!invitation);
    check("welcome email includes the account name", invitation?.html?.includes(`Hi ${name}`));
    check("welcome email includes the public app URL", invitation?.html?.includes(appUrl));
    check("welcome email includes add-a-site guidance", invitation?.html?.includes("adding your first site"));
    check("welcome email includes invite-your-team guidance", invitation?.html?.includes("invite your team"));
    check(
      "welcome email includes the verification link",
      invitation?.html?.includes(`/verify-email?token=${response.data?.verificationToken}`),
    );
  }

  if (SCENARIO === "reject") {
    check("email rejection is not returned to the user", !response.data?.error);
  }

  console.log(`${SCENARIO}: ${passed} checks passed, ${failures.length} failed (${Math.round(elapsedMs)}ms)`);
  if (failures.length) {
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});