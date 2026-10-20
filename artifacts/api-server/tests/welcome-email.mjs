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
  const orgName = `Welcome <${SCENARIO}> Golf Club`;
  const response = await session("POST", "/auth/register", {
    email,
    password: "welcome-password-123",
    name,
    orgName,
    services: ["firetrack", "kitchentrack"],
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

  let invitation;
  if (SCENARIO === "success") {
    // The email is sent in the background after the response, so allow the
    // capture write a moment to land instead of racing it.
    for (let waitedMs = 0; waitedMs <= 5000 && !invitation; waitedMs += 100) {
      invitation = capturedEmails().find((entry) => entry.to === email);
      if (!invitation) await new Promise((resolve) => setTimeout(resolve, 100));
    }
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

    // ALPS (ADMIN_EMAIL) hears about each sign-up so it can welcome them.
    let alert;
    for (let waitedMs = 0; waitedMs <= 5000 && !alert; waitedMs += 100) {
      alert = capturedEmails().find((entry) => entry.to === "alps-admin@test.local" && entry.html?.includes(email));
      if (!alert) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check("ALPS is told about the new sign-up", !!alert);
    check("the sign-up alert names the business", alert?.subject === `New ComplyTrack sign-up: ${orgName}`, alert?.subject);
    check("the sign-up alert escapes the business name", alert?.html?.includes(`Welcome &lt;${SCENARIO}&gt; Golf Club`) && !alert?.html?.includes(`<${SCENARIO}>`));
    check("the sign-up alert lists the modules picked", alert?.html?.includes("FireTrack, KitchenTrack"));
    check("the sign-up alert gives the trial end date", /Free trial ends/.test(alert?.html ?? "") && /\d{1,2} [A-Z][a-z]+ \d{4}/.test(alert?.text ?? ""));
    check(
      "only the welcome email goes to the new business",
      capturedEmails().filter((entry) => entry.to === email).length === 1,
    );
  }

  if (SCENARIO === "reject") {
    check("email rejection is not returned to the user", !response.data?.error);
  }

  // Recovery: a new verification link can be requested from the sign-in flow.
  // The answer is identical for unknown addresses, and a failed or slow send
  // never shows up in the response.
  const unknown = await session("POST", "/auth/resend-verification", { email: `nobody-${SCENARIO}-${ts}@test.local` });
  const resendStartedAt = performance.now();
  const resend = await session("POST", "/auth/resend-verification", { email: email.toUpperCase() });
  const resendMs = performance.now() - resendStartedAt;
  check("resend for the new account succeeds", resend.status === 200, `got ${resend.status}`);
  check(
    "resend answers an unknown address identically",
    unknown.status === resend.status && JSON.stringify(unknown.data) === JSON.stringify(resend.data),
    `${JSON.stringify(unknown.data)} vs ${JSON.stringify(resend.data)}`,
  );
  check("resend response carries no delivery details", JSON.stringify(resend.data) === JSON.stringify({ sent: true }), JSON.stringify(resend.data));
  if (SCENARIO === "delay") {
    check("resend does not wait for delayed email delivery", resendMs < DELAY_MS / 2, `${Math.round(resendMs)}ms`);
  }

  if (SCENARIO === "success") {
    let resent;
    for (let waitedMs = 0; waitedMs <= 5000 && !resent; waitedMs += 100) {
      resent = capturedEmails().find((entry) => entry.to === email && entry.subject === "Verify your ComplyTrack email address");
      if (!resent) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check("a new verification email is sent", !!resent);
    check(
      "the resent email has the same branded layout as the welcome email",
      /<h2[^>]*>Verify your ComplyTrack email address<\/h2>/.test(resent?.html ?? "")
        && /<a href="[^"]+verify-email\?token=[0-9a-f]{64}" style="background: #2563eb/.test(resent?.html ?? "")
        && /<strong>ComplyTrack<\/strong>/.test(resent?.html ?? ""),
      resent?.html,
    );
    check(
      "the welcome and resent emails use the shared ComplyTrack design",
      [invitation?.html, resent?.html].every((html) => (html ?? "").split('data-complytrack-email="1"').length === 2
        && html.includes("/email-assets/alps-logo.png")
        && html.includes("ALPS Consulting Ltd t/as ALPS Consultancy")),
    );
    check("no email is sent for an unknown address", !capturedEmails().some((entry) => entry.to.startsWith("nobody-")));
    const newToken = resent?.html?.match(/verify-email\?token=([0-9a-f]{64})/)?.[1] ?? "";
    const oldLink = await session("GET", `/auth/verify-email?token=${encodeURIComponent(response.data?.verificationToken ?? "")}`);
    check("the new link replaces the welcome email's link", oldLink.status === 400, `got ${oldLink.status}`);
    const verified = await session("GET", `/auth/verify-email?token=${encodeURIComponent(newToken)}`);
    check("the new verification link verifies the account", verified.status === 200, `got ${verified.status}`);
    const login = await makeSession()("POST", "/auth/login", { email, password: "welcome-password-123" });
    check("the verified owner can sign in", login.status === 200, `got ${login.status}`);

    // Three resends per address per hour, so one inbox can't be flooded.
    await session("POST", "/auth/resend-verification", { email });
    await session("POST", "/auth/resend-verification", { email });
    const limited = await session("POST", "/auth/resend-verification", { email });
    check("a fourth resend to one address within the hour is limited", limited.status === 429, `got ${limited.status}`);
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