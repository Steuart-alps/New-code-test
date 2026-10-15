// E2E regression test for the client-admin staff invitation flow.
// Usage: node tests/staff-invitations.mjs (API must be running on API_BASE)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function psql(statement) {
  execFileSync("psql", [process.env.DATABASE_URL, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" });
}

async function invitationOf(session, userId) {
  const list = await session("GET", "/users");
  const row = Array.isArray(list.data) ? list.data.find((u) => u.id === userId) : undefined;
  return { status: list.status, row, raw: JSON.stringify(list.data ?? null) };
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
  // The emailed link is the credential; the database holds only its digest.
  const emailedToken = invitationUrl?.searchParams.get("token") ?? "";
  check(
    "invitation URL token matches the stored digest, never the plaintext",
    /^[0-9a-f]{64}$/.test(emailedToken)
      && tokens[0]?.token === `sha256:${createHash("sha256").update(emailedToken).digest("hex")}`,
    invitationUrl?.toString(),
  );

  // User Management shows the setup link as pending with its expiry, and
  // never the link or its digest.
  const pending = await invitationOf(admin, invitedId);
  check("user list loads", pending.status === 200, `got ${pending.status}`);
  check("new invitation is pending", pending.row?.invitation?.status === "pending", JSON.stringify(pending.row));
  check(
    "pending invitation expiry matches the stored link",
    tokens.length === 1 && Math.abs(Date.parse(pending.row?.invitation?.expiresAt ?? "") - tokens[0].expiresAt) < 1000,
    JSON.stringify(pending.row?.invitation),
  );
  check("user list never carries the setup link", !pending.raw.includes(emailedToken) && !pending.raw.includes(tokens[0]?.token ?? "sha256:"));

  // Another business's admin can't see this staff member or their invitation.
  const outsider = makeSession();
  const outsiderEmail = `staff-invite-outsider-${ts}@test.local`;
  const outsiderReg = await outsider("POST", "/auth/register", { email: outsiderEmail, password: "outsider-password-123", name: "Outsider Admin" });
  await outsider("GET", `/auth/verify-email?token=${encodeURIComponent(outsiderReg.data?.verificationToken ?? "")}`);
  await outsider("POST", "/auth/login", { email: outsiderEmail, password: "outsider-password-123" });
  const outsiderList = await outsider("GET", `/users?clientId=${clientId}`);
  check("outsider's user list loads", outsiderList.status === 200 || outsiderList.status === 403, `got ${outsiderList.status}`);
  const outsiderRaw = JSON.stringify(outsiderList.data ?? null);
  check("outsider sees neither the invited staff member nor their invitation", !outsiderRaw.includes(invitedEmail) && !outsiderRaw.includes(`"id":${invitedId},`), outsiderRaw);

  // An unused link past its expiry shows as expired; a resend makes it pending again.
  psql(`UPDATE password_reset_tokens SET expires_at = now() - interval '2 hours' WHERE user_id = ${Number(invitedId)} AND used_at IS NULL`);
  const expired = await invitationOf(admin, invitedId);
  check("lapsed invitation shows as expired", expired.row?.invitation?.status === "expired", JSON.stringify(expired.row));
  const resent = await admin("POST", `/users/${invitedId}/resend-invite`);
  check("resend setup link", resent.status === 200, `got ${resent.status}`);
  const afterResend = await invitationOf(admin, invitedId);
  check("resent invitation is pending again", afterResend.row?.invitation?.status === "pending", JSON.stringify(afterResend.row));
  check(
    "resent invitation expires about 24 hours from now",
    Date.parse(afterResend.row?.invitation?.expiresAt ?? "") > Date.now() + 23 * 60 * 60 * 1000,
    JSON.stringify(afterResend.row?.invitation),
  );
  const resentEmail = capturedEmails().filter((email) => email.to === invitedEmail).at(-1);
  const resentToken = resentEmail?.html?.match(/reset-password\?token=([0-9a-f]{64})/)?.[1] ?? "";
  check("resend emails a new setup link", resentToken.length === 64 && resentToken !== emailedToken);
  const staleSetup = await admin("POST", "/auth/reset-password", { token: emailedToken, password: "stale-password-456" });
  check("first setup link stops working after a resend", staleSetup.status === 400, `got ${staleSetup.status}`);

  // Revoking cancels the live link without emailing a replacement.
  const outsiderRevoke = await outsider("POST", `/users/${invitedId}/revoke-invite`);
  check("another business can't revoke the setup link", outsiderRevoke.status === 403, `got ${outsiderRevoke.status}`);
  check("refused revoke leaves the link pending", (await invitationOf(admin, invitedId)).row?.invitation?.status === "pending");
  const emailsBeforeRevoke = capturedEmails().filter((email) => email.to === invitedEmail).length;
  const revoke = await admin("POST", `/users/${invitedId}/revoke-invite`);
  check("admin revokes the setup link", revoke.status === 200 && revoke.data?.revoked === 1, `got ${revoke.status} ${JSON.stringify(revoke.data)}`);
  check("revoking sends no email", capturedEmails().filter((email) => email.to === invitedEmail).length === emailsBeforeRevoke);
  const revokedState = await invitationOf(admin, invitedId);
  check("revoked invitation shows as revoked", revokedState.row?.invitation?.status === "revoked" && !!revokedState.row?.invitation?.revokedAt, JSON.stringify(revokedState.row));
  const revokedUse = await admin("POST", "/auth/reset-password", { token: resentToken, password: "revoked-password-456" });
  check("revoked setup link fails through reset-password", revokedUse.status === 400, `got ${revokedUse.status}`);
  check("revoked link row is kept, not deleted", tokenRows(invitedId).length === 2, JSON.stringify(tokenRows(invitedId)));
  const auditRow = execFileSync("psql", [process.env.DATABASE_URL, "-X", "-At", "-c",
    `SELECT actor_id, client_id FROM audit_events WHERE entity_type = 'user' AND entity_id = ${Number(invitedId)} AND action = 'setup_link_revoked'`,
  ], { encoding: "utf8" }).trim();
  check("revocation is recorded with who did it", auditRow === `${me.data?.user?.id}|${clientId}`, auditRow);
  const revokeAgain = await admin("POST", `/users/${invitedId}/revoke-invite`);
  check("nothing left to revoke is reported", revokeAgain.status === 409, `got ${revokeAgain.status}`);
  const revokeOwner = await admin("POST", `/users/${me.data?.user?.id}/revoke-invite`);
  check("revoke is limited to staff accounts", revokeOwner.status === 400, `got ${revokeOwner.status}`);

  const reinvite = await admin("POST", `/users/${invitedId}/resend-invite`);
  check("a new link can be sent after revoking", reinvite.status === 200, `got ${reinvite.status}`);
  check("re-sent invitation is pending", (await invitationOf(admin, invitedId)).row?.invitation?.status === "pending");
  const finalToken = capturedEmails().filter((email) => email.to === invitedEmail).at(-1)?.html?.match(/reset-password\?token=([0-9a-f]{64})/)?.[1] ?? "";
  check("re-sent invitation has a fresh link", finalToken.length === 64 && finalToken !== resentToken);

  const reset = await admin("POST", "/auth/reset-password", {
    token: finalToken,
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
    token: finalToken,
    password: "another-password-789",
  });
  check("invitation token cannot be reused", reuse.status === 400, `got ${reuse.status}`);
  check("used invitation token is recorded as used", tokenRows(invitedId).every((row) => !row.unused));
  const completed = await invitationOf(admin, invitedId);
  check("used invitation shows as completed", completed.row?.invitation?.status === "completed", JSON.stringify(completed.row));

  // A later forgot-password link is not a setup invitation.
  const forgot = await admin("POST", "/auth/forgot-password", { email: invitedEmail });
  check("forgot-password accepted", forgot.status === 200, `got ${forgot.status}`);
  check("forgot-password created a live reset link", tokenRows(invitedId).some((row) => row.unused));
  const afterForgot = await invitationOf(admin, invitedId);
  check("a reset link doesn't reopen a completed invitation", afterForgot.row?.invitation?.status === "completed", JSON.stringify(afterForgot.row));

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
  const explicitRow = await invitationOf(admin, explicit.data?.id);
  check("staff created with a password have no invitation", explicitRow.row !== undefined && explicitRow.row.invitation === null, JSON.stringify(explicitRow.row));

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