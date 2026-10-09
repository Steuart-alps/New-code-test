// Invite and password-reset flows on a database built only from runtime
// migrations (password_reset_tokens used to exist only via drizzle push).
//
//   bash tests/run-fresh-schema.sh tests/password-reset-fresh-schema.mjs
//
// Uses the harness's private API and captured system mail; the harness also
// fails the run if the server logged a missing relation or column.

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const base = process.env.API_BASE;
const outbox = process.env.TEST_EMAIL_CAPTURE_PATH;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname) || !outbox) {
  throw new Error("Run via tests/run-fresh-schema.sh: needs the disposable API and captured mail.");
}

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function mailTo(email) {
  let content = "";
  try { content = await readFile(outbox, "utf8"); } catch { /* not created yet */ }
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((m) => m.to === email);
}
const linkToken = (message) => {
  const match = /reset-password\?token=([0-9a-f]{64})/.exec(message.text ?? "");
  assert.ok(match, "email must contain a reset-password link");
  return match[1];
};

test("invite, reset and forgot-password work on a runtime-migrated database", async () => {
  await writeFile(outbox, "", { flag: "a" });
  const password = "fresh-schema-owner-123";
  const owner = session();
  const ownerEmail = `reset-owner-${randomUUID()}@test.local`;
  const registered = await owner("POST", "/auth/register", { name: "Reset Owner", email: ownerEmail, password });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal((await owner("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
  assert.equal((await owner("POST", "/auth/login", { email: ownerEmail, password })).status, 200);

  // Invite (no password): account plus a set-up link from password_reset_tokens.
  const staffEmail = `reset-staff-${randomUUID()}@test.local`;
  const me = await owner("GET", "/auth/me");
  const clientId = (me.data.user ?? me.data).clientId;
  assert.ok(Number.isInteger(clientId));
  const invited = await owner("POST", "/users", { name: "Invited Staff", email: staffEmail, role: "client_staff", clientId });
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const invites = await mailTo(staffEmail);
  assert.equal(invites.length, 1, "invite email must be sent");
  assert.match(invites[0].subject, /invited/i);
  const firstInviteToken = linkToken(invites[0]);

  // Resending supersedes the earlier link.
  const resend = await owner("POST", `/users/${invited.data.id}/resend-invite`);
  assert.equal(resend.status, 200, JSON.stringify(resend.data));
  const resent = await mailTo(staffEmail);
  assert.equal(resent.length, 2);
  const inviteToken = linkToken(resent[1]);
  assert.notEqual(inviteToken, firstInviteToken);

  const anon = session();
  const staffPassword = "fresh-schema-staff-123";
  assert.equal((await anon("POST", "/auth/reset-password", { token: firstInviteToken, password: staffPassword })).status, 400,
    "superseded invite link must be rejected");
  assert.equal((await anon("POST", "/auth/reset-password", { token: inviteToken, password: staffPassword })).status, 200);
  assert.equal((await anon("POST", "/auth/reset-password", { token: inviteToken, password: "another-password-1" })).status, 400,
    "a used link cannot be replayed");
  assert.equal((await session()("POST", "/auth/login", { email: staffEmail, password: staffPassword })).status, 200);

  // Forgot-password issues a fresh link which resets the password.
  assert.equal((await anon("POST", "/auth/forgot-password", { email: staffEmail })).status, 200);
  const resetMail = (await mailTo(staffEmail)).filter((m) => /reset your password/i.test(m.subject));
  assert.equal(resetMail.length, 1, "forgot-password email must be sent");
  const newPassword = "fresh-schema-reset-456";
  assert.equal((await anon("POST", "/auth/reset-password", { token: linkToken(resetMail[0]), password: newPassword })).status, 200);
  assert.equal((await session()("POST", "/auth/login", { email: staffEmail, password: staffPassword })).status, 401);
  assert.equal((await session()("POST", "/auth/login", { email: staffEmail, password: newPassword })).status, 200);
});
