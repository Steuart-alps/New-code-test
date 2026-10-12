// Deterministic TOTP sign-in for API integration fixtures.
//
// By default an account must enrol an authenticator before it can use the app
// (.agents/memory/mandatory-two-factor.md). These helpers drive the same
// endpoints as the web app: password login, GET /auth/2fa/setup for the secret,
// POST /auth/2fa/enable with a code computed here (RFC 6238: SHA-1, 6 digits,
// 30-second steps), and POST /auth/2fa/verify on later sign-ins. The secret is
// returned so a fixture can sign the same user in again.
//
// `request(method, path, body)` is any cookie-carrying session function that
// resolves to `{ status, data }` (each suite's makeSession/requestSession).
// Enrolment proves the policy as it goes: the probe routes are refused (401 or
// 403) while the session is setup-only, and get past authentication (any other
// status) once the authenticator is enrolled.
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret) {
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character in TOTP secret: ${char}`);
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The 6-digit TOTP code for a base32 `secret` at `time` (ms since epoch). */
export function totpCode(secret, time = Date.now()) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export const DEFAULT_PROBE_PATHS = Object.freeze(["/sites"]);

function fail(label, step, response) {
  const body = JSON.stringify(response?.data) ?? "";
  return new Error(`${label}: ${step} (status ${response?.status}: ${body.length > 300 ? `${body.slice(0, 300)}…` : body})`);
}

async function expectProbes(request, label, probePaths, enrolled) {
  for (const path of probePaths) {
    const response = await request("GET", path);
    if ([401, 403].includes(response.status) === enrolled) {
      const expected = enrolled ? "usable after 2FA enrolment" : "blocked before 2FA enrolment";
      throw fail(label, `GET ${path} must be ${expected}`, response);
    }
  }
}

/**
 * Enrol a new TOTP authenticator on a setup-only or signed-in session (the
 * latter is voluntary enrolment where an organisation does not require 2FA).
 * Resolves to `{ secret, recoveryCodes }`.
 */
export async function enrolTotp(request, { label = "fixture user" } = {}) {
  const setup = await request("GET", "/auth/2fa/setup");
  if (setup.status !== 200 || typeof setup.data?.secret !== "string") throw fail(label, "2FA setup", setup);
  const enabled = await request("POST", "/auth/2fa/enable", { code: totpCode(setup.data.secret) });
  if (enabled.status !== 200) throw fail(label, "2FA enrolment", enabled);
  return { secret: setup.data.secret, recoveryCodes: enabled.data?.recoveryCodes ?? [] };
}

/**
 * Complete a password sign-in. `login` is the response to POST /auth/login on
 * the same session.
 *
 * - `requires2faSetup`: checks the probe routes are blocked, enrols a new
 *   authenticator, then checks they are usable.
 * - `requires2fa`: answers the challenge with the `secret` from enrolment.
 * - neither: the API issued a password-only session. That is an error unless
 *   `allowPasswordOnly` is set: pass it where the scenario expects no second
 *   factor (e.g. an organisation that has turned the requirement off). It
 *   defaults to ALLOW_PASSWORD_ONLY_TEST_LOGIN=1 in this process, the legacy
 *   runner opt-in. With `enrol: true` the password-only session enrols a new
 *   authenticator anyway, as a user choosing 2FA would.
 *
 * Resolves to `{ secret, recoveryCodes, enrolled }`; `secret` is null for a
 * password-only session that did not enrol.
 */
export async function completeTwoFactor(request, login, {
  label = "fixture user",
  secret = null,
  probePaths = DEFAULT_PROBE_PATHS,
  allowPasswordOnly = process.env.ALLOW_PASSWORD_ONLY_TEST_LOGIN === "1",
  enrol = false,
} = {}) {
  if (login?.status !== 200) throw fail(label, "password login failed", login);

  if (login.data?.requires2faSetup) {
    await expectProbes(request, label, probePaths, false);
    const enrolment = await enrolTotp(request, { label });
    await expectProbes(request, label, probePaths, true);
    return { ...enrolment, enrolled: true };
  }

  if (login.data?.requires2fa) {
    if (!secret) throw new Error(`${label}: login asks for an authenticator code but the fixture has no TOTP secret`);
    const verified = await request("POST", "/auth/2fa/verify", { code: totpCode(secret) });
    if (verified.status !== 200) throw fail(label, "2FA verification", verified);
    return { secret, recoveryCodes: [], enrolled: false };
  }

  if (!allowPasswordOnly) {
    throw fail(label, "login granted a session without a second factor, but this scenario requires 2FA", login);
  }
  if (enrol) return { ...(await enrolTotp(request, { label })), enrolled: true };
  return { secret: null, recoveryCodes: [], enrolled: false };
}

/** POST /auth/login, then `completeTwoFactor`. Same options. */
export async function signIn(request, { email, password, ...options }) {
  const login = await request("POST", "/auth/login", { email, password });
  return completeTwoFactor(request, login, options);
}
