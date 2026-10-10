// Passkey registration and sign-in regression tests against a running API,
// using software WebAuthn credentials (tests/webauthn-test-authenticator.mjs).
// Run through tests/run-passkey-webauthn.sh, which boots the API twice on a
// disposable database:
//   PASSKEY_TEST_MODE=enforced — production policy (ENFORCE_MANDATORY_2FA=1):
//     registration, sign-in, expired/replayed challenges, unknown and
//     cross-user credentials, removal with TOTP enabled.
//   PASSKEY_TEST_MODE=legacy — the 2FA enrolment guard is off, so a signed-in
//     account without TOTP reaches DELETE /auth/passkeys/:id and the route's
//     own last-passkey rule is exercised directly.
// Expiry is simulated by back-dating the challenge timestamp in the session
// row, so the suite never waits for the five-minute TTL.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { TestAuthenticator } from "./webauthn-test-authenticator.mjs";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const MODE = process.env.PASSKEY_TEST_MODE || "enforced";
const ORIGIN = new URL(process.env.PASSKEY_ORIGIN || process.env.PUBLIC_APP_URL || "http://localhost:8080").origin;
const PASSWORD = "passkey-test-password-1";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}

function sql(query) {
  return execFileSync("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-qtAc", query], { encoding: "utf8" }).trim();
}

// The login limiter allows ten attempts per source IP; each request gets its
// own forwarded address so the suite never trips it.
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.201.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

class Browser {
  cookie = "";

  async request(method, path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": nextIp(),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) {
      if (header.startsWith("connect.sid=")) this.cookie = header.split(";")[0];
    }
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  sessionId() {
    const signed = decodeURIComponent(this.cookie.slice("connect.sid=".length));
    const sid = signed.slice(2, signed.lastIndexOf("."));
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new Error(`Unexpected session id format: ${sid}`);
    return sid;
  }

  /** Back-date a challenge timestamp in this browser's stored session. */
  ageSessionField(field, ageMs) {
    const updated = sql(`
      UPDATE sessions
      SET sess = (sess::jsonb || jsonb_build_object('${field}', ${Date.now() - ageMs}::bigint))::json
      WHERE sid = '${this.sessionId()}' AND sess::jsonb ? '${field}'
      RETURNING sid
    `);
    if (!updated) throw new Error(`Session has no ${field} to age`);
  }
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function currentTotp(secret) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function createAccount(label) {
  const email = `passkey-${label}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}@test.local`;
  const signup = new Browser();
  const registered = await signup.request("POST", "/auth/register", { name: `Passkey ${label}`, email, password: PASSWORD });
  if (registered.status !== 200 || typeof registered.data?.verificationToken !== "string") {
    throw new Error(`Could not register ${label}: ${registered.status} ${JSON.stringify(registered.data)}`);
  }
  const verified = await signup.request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  if (verified.status !== 200) throw new Error(`Could not verify ${label}'s email: ${verified.status}`);
  const id = Number(sql(`SELECT id FROM users WHERE email = '${email}'`));
  return { email, id, label };
}

async function enrolTotp(browser) {
  const setup = await browser.request("GET", "/auth/2fa/setup");
  if (setup.status !== 200) throw new Error(`2FA setup failed: ${setup.status} ${JSON.stringify(setup.data)}`);
  const enabled = await browser.request("POST", "/auth/2fa/enable", { code: currentTotp(setup.data.secret) });
  if (enabled.status !== 200) throw new Error(`2FA enable failed: ${enabled.status} ${JSON.stringify(enabled.data)}`);
  return setup.data.secret;
}

async function registerPasskey(browser, authenticator) {
  const options = await browser.request("POST", "/auth/passkeys/registration/options");
  if (options.status !== 200) return { options, verified: options };
  const verified = await browser.request("POST", "/auth/passkeys/registration/verify", authenticator.createCredential(options.data));
  return { options, verified };
}

function passkeyOwner(credentialId) {
  return sql(`SELECT user_id FROM passkeys WHERE credential_id = '${credentialId}'`);
}

function passkeyCount(userId) {
  return Number(sql(`SELECT count(*) FROM passkeys WHERE user_id = ${userId}`));
}

async function hasFullSession(browser) {
  return (await browser.request("GET", "/auth/passkeys")).status === 200;
}

async function enforcedSuite() {
  // ── Registration during mandatory setup ───────────────────────────────────
  const alice = await createAccount("alice");
  const aliceKey = new TestAuthenticator({ origin: ORIGIN });
  const aliceBrowser = new Browser();

  const firstLogin = await aliceBrowser.request("POST", "/auth/login", { email: alice.email, password: PASSWORD });
  check("password login without TOTP starts mandatory setup", firstLogin.status === 200 && firstLogin.data?.requires2faSetup === true, firstLogin);

  const regOptions = await aliceBrowser.request("POST", "/auth/passkeys/registration/options");
  check("setup session can request registration options", regOptions.status === 200 && typeof regOptions.data?.challenge === "string", regOptions);
  check("registration options name the configured relying party", regOptions.data?.rp?.id === new URL(ORIGIN).hostname, regOptions.data?.rp);
  const aliceAttestation = aliceKey.createCredential(regOptions.data);
  const regVerified = await aliceBrowser.request("POST", "/auth/passkeys/registration/verify", aliceAttestation);
  check("test credential registers during setup", regVerified.status === 200 && regVerified.data?.ok === true, regVerified);
  check("setup registration still requires TOTP enrolment", regVerified.data?.requires2faSetup === true, regVerified);
  check("passkey is stored for the registering user", passkeyOwner(aliceKey.id) === String(alice.id));
  check("passkey registration does not grant a full session", !(await hasFullSession(aliceBrowser)));

  // ── Replayed and expired registration challenges ──────────────────────────
  const replayedRegistration = await aliceBrowser.request("POST", "/auth/passkeys/registration/verify", aliceAttestation);
  check("replayed registration response is rejected once its challenge is used", replayedRegistration.status === 400, replayedRegistration);

  await aliceBrowser.request("POST", "/auth/passkeys/registration/options");
  const replayIntoNewChallenge = await aliceBrowser.request("POST", "/auth/passkeys/registration/verify", aliceAttestation);
  check("old registration response is rejected against a new challenge", replayIntoNewChallenge.status === 400, replayIntoNewChallenge);

  const lateKey = new TestAuthenticator({ origin: ORIGIN });
  const lateOptions = await aliceBrowser.request("POST", "/auth/passkeys/registration/options");
  aliceBrowser.ageSessionField("pendingPasskeyRegistrationCreatedAt", CHALLENGE_TTL_MS + 60_000);
  const lateAttestation = lateKey.createCredential(lateOptions.data);
  const expiredRegistration = await aliceBrowser.request("POST", "/auth/passkeys/registration/verify", lateAttestation);
  check("registration with an expired challenge is rejected", expiredRegistration.status === 400, expiredRegistration);
  check("expired registration stores no credential", passkeyOwner(lateKey.id) === "");
  const retryExpiredRegistration = await aliceBrowser.request("POST", "/auth/passkeys/registration/verify", lateAttestation);
  check("expired registration challenge is cleared, not reusable", retryExpiredRegistration.status === 400, retryExpiredRegistration);

  const aliceTotp = await enrolTotp(aliceBrowser);
  check("TOTP enrolment grants the full session", await hasFullSession(aliceBrowser));
  const aliceList = await aliceBrowser.request("GET", "/auth/passkeys");
  check("account lists exactly the one verified passkey", aliceList.status === 200 && aliceList.data?.passkeys?.length === 1, aliceList);
  const alicePasskeyId = aliceList.data?.passkeys?.[0]?.id;

  // ── Passkey sign-in ───────────────────────────────────────────────────────
  await aliceBrowser.request("POST", "/auth/logout");
  const login = await aliceBrowser.request("POST", "/auth/login", { email: alice.email, password: PASSWORD });
  check("password login offers a passkey challenge", login.status === 200 && login.data?.requiresPasskey === true && typeof login.data?.passkeyOptions?.challenge === "string", login);
  check("password login still requires TOTP", login.data?.requires2fa === true, login);
  check("challenge allows only the account's own credential",
    JSON.stringify(login.data?.passkeyOptions?.allowCredentials?.map((c) => c.id)) === JSON.stringify([aliceKey.id]),
    login.data?.passkeyOptions?.allowCredentials);
  const aliceAssertion = aliceKey.getAssertion(login.data.passkeyOptions);
  const signedIn = await aliceBrowser.request("POST", "/auth/passkeys/authenticate", aliceAssertion);
  check("valid passkey assertion is accepted", signedIn.status === 200 && signedIn.data?.user?.id === alice.id, signedIn);
  check("passkey sign-in leaves the TOTP step pending", signedIn.data?.requires2fa === true, signedIn);
  check("passkey alone does not grant a full session", !(await hasFullSession(aliceBrowser)));
  check("verified assertion advances the stored signature counter", sql(`SELECT counter FROM passkeys WHERE credential_id = '${aliceKey.id}'`) === "1");

  const replayedAssertion = await aliceBrowser.request("POST", "/auth/passkeys/authenticate", aliceAssertion);
  check("replayed assertion is rejected once its challenge is used", replayedAssertion.status === 400, replayedAssertion);

  const totp = await aliceBrowser.request("POST", "/auth/2fa/verify", { code: currentTotp(aliceTotp) });
  check("TOTP after passkey completes sign-in", totp.status === 200 && totp.data?.user?.id === alice.id, totp);
  check("completed sign-in grants the full session", await hasFullSession(aliceBrowser));
  const usedList = await aliceBrowser.request("GET", "/auth/passkeys");
  check("passkey records its last use", Boolean(usedList.data?.passkeys?.[0]?.lastUsedAt), usedList.data);

  await aliceBrowser.request("POST", "/auth/logout");
  const relogin = await aliceBrowser.request("POST", "/auth/login", { email: alice.email, password: PASSWORD });
  const replayAcrossLogins = await aliceBrowser.request("POST", "/auth/passkeys/authenticate", aliceAssertion);
  check("assertion from an earlier sign-in is rejected against a new challenge", replayAcrossLogins.status === 401, replayAcrossLogins);
  const afterReplay = await aliceBrowser.request("POST", "/auth/passkeys/authenticate", aliceKey.getAssertion(relogin.data.passkeyOptions));
  check("a rejected replay does not block the genuine assertion", afterReplay.status === 200 && afterReplay.data?.requires2fa === true, afterReplay);

  // ── Expired sign-in challenge ─────────────────────────────────────────────
  const staleBrowser = new Browser();
  const staleLogin = await staleBrowser.request("POST", "/auth/login", { email: alice.email, password: PASSWORD });
  staleBrowser.ageSessionField("pendingPasskeyChallengeCreatedAt", CHALLENGE_TTL_MS + 60_000);
  const expiredSignIn = await staleBrowser.request("POST", "/auth/passkeys/authenticate", aliceKey.getAssertion(staleLogin.data.passkeyOptions));
  check("assertion for an expired challenge is rejected", expiredSignIn.status === 400, expiredSignIn);
  const retryExpiredSignIn = await staleBrowser.request("POST", "/auth/passkeys/authenticate", aliceKey.getAssertion(staleLogin.data.passkeyOptions));
  check("expired sign-in challenge is cleared, not reusable", retryExpiredSignIn.status === 400, retryExpiredSignIn);
  check("expired challenge grants no session", !(await hasFullSession(staleBrowser)));

  // ── Unknown credentials ───────────────────────────────────────────────────
  const unknownBrowser = new Browser();
  const unknownLogin = await unknownBrowser.request("POST", "/auth/login", { email: alice.email, password: PASSWORD });
  const strangerKey = new TestAuthenticator({ origin: ORIGIN });
  const unknownCredential = await unknownBrowser.request("POST", "/auth/passkeys/authenticate", strangerKey.getAssertion(unknownLogin.data.passkeyOptions));
  check("assertion from an unregistered credential is rejected", unknownCredential.status === 401, unknownCredential);
  const missingCredential = await unknownBrowser.request("POST", "/auth/passkeys/authenticate", {});
  check("assertion without a credential id is rejected", missingCredential.status === 401, missingCredential);
  check("unknown credentials grant no session", !(await hasFullSession(unknownBrowser)));

  // ── Cross-user credentials ────────────────────────────────────────────────
  const bob = await createAccount("bob");
  const bobKey = new TestAuthenticator({ origin: ORIGIN });
  const bobBrowser = new Browser();
  await bobBrowser.request("POST", "/auth/login", { email: bob.email, password: PASSWORD });
  await enrolTotp(bobBrowser);
  const bobRegistration = await registerPasskey(bobBrowser, bobKey);
  check("signed-in account registers a passkey without the setup flag",
    bobRegistration.verified.status === 200 && bobRegistration.verified.data?.ok === true && !bobRegistration.verified.data?.requires2faSetup,
    bobRegistration.verified);
  check("registration options exclude the account's existing credentials",
    (await bobBrowser.request("POST", "/auth/passkeys/registration/options")).data?.excludeCredentials?.some((c) => c.id === bobKey.id));

  const hijack = await bobBrowser.request("POST", "/auth/passkeys/registration/verify", aliceKey.createCredential(
    (await bobBrowser.request("POST", "/auth/passkeys/registration/options")).data,
  ));
  check("another user's credential id cannot be registered", hijack.status >= 400 && hijack.status < 500, hijack);
  check("the credential still belongs to its original owner", passkeyOwner(aliceKey.id) === String(alice.id));
  check("a duplicate credential is reported as already registered", hijack.status === 409, hijack);

  await bobBrowser.request("POST", "/auth/logout");
  const bobLogin = await bobBrowser.request("POST", "/auth/login", { email: bob.email, password: PASSWORD });
  const crossUser = await bobBrowser.request("POST", "/auth/passkeys/authenticate", aliceKey.getAssertion(bobLogin.data.passkeyOptions));
  check("another user's passkey cannot complete this user's sign-in", crossUser.status === 401, crossUser);
  const forged = await bobBrowser.request("POST", "/auth/passkeys/authenticate", aliceKey.getAssertion(bobLogin.data.passkeyOptions, { claimId: bobKey.id }));
  check("an assertion presenting this user's credential id with another key is rejected", forged.status === 401, forged);
  check("cross-user attempts grant no session", !(await hasFullSession(bobBrowser)));
  const bobSignedIn = await bobBrowser.request("POST", "/auth/passkeys/authenticate", bobKey.getAssertion(bobLogin.data.passkeyOptions));
  check("the pending sign-in still belongs to the password user", bobSignedIn.status === 200 && bobSignedIn.data?.user?.id === bob.id, bobSignedIn);

  // Alice's browser is still at the TOTP step from the replay checks above.
  const aliceComplete = await aliceBrowser.request("POST", "/auth/2fa/verify", { code: currentTotp(aliceTotp) });
  check("first user completes sign-in again", aliceComplete.status === 200, aliceComplete);
  const bobPasskeyId = sql(`SELECT id FROM passkeys WHERE credential_id = '${bobKey.id}'`);
  const crossDelete = await aliceBrowser.request("DELETE", `/auth/passkeys/${bobPasskeyId}`);
  check("a user cannot remove another user's passkey", crossDelete.status === 404, crossDelete);
  check("the other user's passkey survives", passkeyOwner(bobKey.id) === String(bob.id));

  // ── Removal rules under the production policy ─────────────────────────────
  const removed = await aliceBrowser.request("DELETE", `/auth/passkeys/${alicePasskeyId}`);
  check("last passkey can be removed when TOTP is enabled", removed.status === 200 && removed.data?.ok === true, removed);
  check("removed passkey is gone", passkeyCount(alice.id) === 0);
  await aliceBrowser.request("POST", "/auth/logout");
  const loginAfterRemoval = await aliceBrowser.request("POST", "/auth/login", { email: alice.email, password: PASSWORD });
  check("sign-in stops offering a removed passkey", loginAfterRemoval.data?.requires2fa === true && !loginAfterRemoval.data?.requiresPasskey, loginAfterRemoval);

  // A signed-in account whose TOTP was reset (e.g. by an admin) has no second
  // factor; the enrolment guard must stop it removing its only passkey.
  const bobFull = new Browser();
  await bobFull.request("POST", "/auth/login", { email: bob.email, password: PASSWORD });
  const bobSecret = sql(`SELECT totp_secret FROM users WHERE id = ${bob.id}`);
  await bobFull.request("POST", "/auth/2fa/verify", { code: currentTotp(bobSecret) });
  check("second user holds a full session", await hasFullSession(bobFull));
  sql(`UPDATE users SET totp_enabled = false WHERE id = ${bob.id}`);
  const blockedRemoval = await bobFull.request("DELETE", `/auth/passkeys/${bobPasskeyId}`);
  check("only passkey cannot be removed once TOTP is off", blockedRemoval.status === 403 || blockedRemoval.status === 400, blockedRemoval);
  check("blocked removal keeps the passkey", passkeyCount(bob.id) === 1);
}

async function legacySuite() {
  // With the enrolment guard off, password login issues a full session for an
  // account without TOTP, so these requests reach the route's own rule.
  const carol = await createAccount("carol");
  const browser = new Browser();
  const login = await browser.request("POST", "/auth/login", { email: carol.email, password: PASSWORD });
  check("legacy test login issues a full session", login.status === 200 && login.data?.user?.id === carol.id, login);

  const firstKey = new TestAuthenticator({ origin: ORIGIN });
  const first = await registerPasskey(browser, firstKey);
  check("first passkey registers", first.verified.status === 200, first.verified);
  const firstId = sql(`SELECT id FROM passkeys WHERE credential_id = '${firstKey.id}'`);

  const onlyRemoval = await browser.request("DELETE", `/auth/passkeys/${firstId}`);
  check("only passkey cannot be removed without TOTP", onlyRemoval.status === 400 && /another security method/.test(onlyRemoval.data?.error ?? ""), onlyRemoval);
  check("blocked removal keeps the only passkey", passkeyCount(carol.id) === 1);

  check("non-numeric passkey id is rejected", (await browser.request("DELETE", "/auth/passkeys/not-a-number")).status === 400);
  check("missing passkey id returns not found", (await browser.request("DELETE", "/auth/passkeys/2147483647")).status === 404);

  const secondKey = new TestAuthenticator({ origin: ORIGIN });
  const second = await registerPasskey(browser, secondKey);
  check("second passkey registers", second.verified.status === 200, second.verified);
  const secondId = sql(`SELECT id FROM passkeys WHERE credential_id = '${secondKey.id}'`);

  const withSpare = await browser.request("DELETE", `/auth/passkeys/${firstId}`);
  check("a passkey can be removed while another passkey remains", withSpare.status === 200, withSpare);
  const lastAgain = await browser.request("DELETE", `/auth/passkeys/${secondId}`);
  check("the remaining passkey is again protected without TOTP", lastAgain.status === 400, lastAgain);

  await enrolTotp(browser);
  const withTotp = await browser.request("DELETE", `/auth/passkeys/${secondId}`);
  check("last passkey can be removed once TOTP is enabled", withTotp.status === 200, withTotp);
  check("account has no passkeys left", passkeyCount(carol.id) === 0);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point at the API's database");
  if (MODE === "enforced") await enforcedSuite();
  else if (MODE === "legacy") await legacySuite();
  else throw new Error(`Unknown PASSKEY_TEST_MODE: ${MODE}`);
  console.log(`passkey WebAuthn (${MODE}): ${passed} checks passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
