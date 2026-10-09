// E2E regression test for the client-admin staff invitation flow.
// Usage: node tests/staff-invitations.mjs (API must be running on API_BASE)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const CAPTURE_PATH = process.env.TEST_EMAIL_CAPTURE_PATH;
if (!CAPTURE_PATH) throw new Error("TEST_EMAIL_CAPTURE_PATH is required");

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

function tokenRows(userId) {
  const output = execFileSync("psql", [
    process.env.DATABASE_URL,
    "-X",
    "-At",
    "-F",
    "\t",
    "-c",
    `SELECT token, EXTRACT(EPOCH FROM expires_at) * 1000, (used_at IS NULL) FROM password_reset_tokens WHERE user_id = ${Number(userId)} ORDER BY id`,
  ], { encoding: "utf8" }).trim();
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [token, expiresAt, unused] = line.split("\t");
    return { token, expiresAt: Number(expiresAt), unused: unused === "t" };
  });
}

function capturedEmails() {
  if (!existsSync(CAPTURE_PATH)) return [];
  const raw = readFileSync(CAPTURE_PATH, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

async function main() {
  const ts = Date.now();
  const admin = makeSession();
  const adminEmail = `staff-invite-admin-${ts}@test.local`;
  const registration = await admin("POST", "/auth/register", {
    email: adminEmail,
    password: "admin-password-123",
    name: "Invitation Admin",
  });
  check("register admin", [200, 201].includes(registration.status), `got ${registration.status}`);
  const verificationToken = registration.data?.verificationToken;
  const verified = await admin("GET", `/auth/verify-email?token=${encodeURIComponent(verificationToken ?? "")}`);
  check("verify admin email", verified.status === 200, `got ${verified.status}`);
  const login = await admin("POST", "/auth/login", {
    email: adminEmail,
    password: "admin-password-123",
  });
  check("login admin", login.status === 200, `got ${login.status}`);
  const me = await admin("GET", "/auth/me");
  const clientId = me.data?.user?.clientId;
  check("admin has client context", Number.isInteger(clientId), JSON.stringify(me.data));

  const invitedEmail = `staff-invite-target-${ts}@test.local`;
  const created = await admin("POST", "/users", {
    email: invitedEmail,
    name: "Invited Staff",
    role: "client_staff",
    clientId,
  });
  check("create staff without password", created.status === 201, `got ${created.status}`);
  const invitedId = created.data?.id;
  const tokens = tokenRows(invitedId);
  check("invitation creates one token", tokens.length === 1, JSON.stringify(tokens));
  check(
    "invitation token is unused and expires in 24 hours",
    tokens.length === 1 &&
      tokens[0].unused &&
      tokens[0].expiresAt > Date.now() + 23 * 60 * 60 * 1000 &&
      tokens[0].expiresAt < Date.now() + 25 * 60 * 60 * 1000,
    JSON.stringify(tokens),
  );

  const invitationEmail = capturedEmails().find((email) => email.to === invitedEmail);
  check("invitation email is captured for the invited staff member", !!invitationEmail);
  const urlMatch = invitationEmail?.html?.match(/href="([^"]*\/reset-password\?token=[^"]+)"/);
  let invitationUrl = null;
  try {
    invitationUrl = urlMatch ? new URL(urlMatch[1]) : null;
  } catch {}
  check("invitation contains the reset-password URL", invitationUrl?.pathname === "/reset-password");
  check(
    "invitation URL contains the database token",
    invitationUrl?.searchParams.get("token") === tokens[0]?.token,
    invitationUrl?.toString(),
  );

  const reset = await admin("POST", "/auth/reset-password", {
    token: tokens[0]?.token,
    password: "staff-password-456",
  });
  check("invitation token sets the password", reset.status === 200, `got ${reset.status}`);
  const staff = makeSession();
  const staffLogin = await staff("POST", "/auth/login", {
    email: invitedEmail,
    password: "staff-password-456",
  });
  check("invited staff can log in with the new password", staffLogin.status === 200, `got ${staffLogin.status}`);
  const reuse = await admin("POST", "/auth/reset-password", {
    token: tokens[0]?.token,
    password: "another-password-789",
  });
  check("invitation token cannot be reused", reuse.status === 400, `got ${reuse.status}`);
  check("used invitation token is recorded as used", tokenRows(invitedId)[0]?.unused === false);

  const explicitEmail = `staff-invite-explicit-${ts}@test.local`;
  const beforeExplicit = capturedEmails().filter((email) => email.to === explicitEmail).length;
  const explicit = await admin("POST", "/users", {
    email: explicitEmail,
    name: "Explicit Password Staff",
    role: "client_staff",
    clientId,
    password: "explicit-password-456",
  });
  check("create staff with explicit password", explicit.status === 201, `got ${explicit.status}`);
  const afterExplicit = capturedEmails().filter((email) => email.to === explicitEmail).length;
  check("explicit password creation sends no invitation", afterExplicit === beforeExplicit);
  const explicitLogin = makeSession();
  const explicitLoginResult = await explicitLogin("POST", "/auth/login", {
    email: explicitEmail,
    password: "explicit-password-456",
  });
  check("explicit password staff can log in", explicitLoginResult.status === 200, `got ${explicitLoginResult.status}`);

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});