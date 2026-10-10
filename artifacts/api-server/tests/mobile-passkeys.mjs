// Native mobile passkeys: a software authenticator plays the phone.
//
// Proves that a mobile passkey stands in for the password only: it always ends
// in the existing TOTP step (or web two-factor setup), never in a bearer
// session, and that challenges, origins and user verification are enforced.
import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const ROOT = BASE.replace(/\/api$/, "");
const RP_ID = new URL(process.env.PUBLIC_APP_URL).hostname;
const WEB_ORIGIN = process.env.PUBLIC_APP_URL.replace(/\/$/, "");
const IOS_ORIGIN = `https://${RP_ID}`;
const ANDROID_ORIGIN = `android:apk-key-hash:${Buffer.from(
  process.env.MOBILE_ANDROID_CERT_SHA256.replace(/:/g, ""),
  "hex",
).toString("base64url")}`;

let passed = 0;
function check(name, condition, detail = "") {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// Each request comes from its own address so the per-IP login limiter, which
// counts every attempt, never interferes with the assertions below.
let ipCounter = 0;
function freshIp() {
  ipCounter++;
  return `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function request(method, path, { body, cookie, bearer, base = BASE } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": freshIp(),
      ...(cookie?.value ? { cookie: cookie.value } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (cookie && setCookie) cookie.value = setCookie.split(";")[0];
  return { status: response.status, data: await response.json().catch(() => null) };
}

// ─── TOTP ────────────────────────────────────────────────────────────────────
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
  const counter = Math.floor(Date.now() / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

// ─── Minimal CBOR encoder (ints, byte/text strings, maps) ────────────────────
function cborHead(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

function cbor(value) {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [key, item] of value) parts.push(cbor(key), cbor(item));
    return Buffer.concat(parts);
  }
  throw new Error(`Unsupported CBOR value: ${value}`);
}

// ─── Software platform authenticator ─────────────────────────────────────────
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

function makeAuthenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = crypto.randomBytes(16);
  return { privateKey, jwk, credentialId, id: credentialId.toString("base64url"), signCount: 0 };
}

function clientData(type, challenge, origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function createCredential(authenticator, options, { origin, uv = true }) {
  const rpIdHash = crypto.createHash("sha256").update(options.rp.id).digest();
  const coseKey = cbor(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(authenticator.jwk.x, "base64url")],
    [-3, Buffer.from(authenticator.jwk.y, "base64url")],
  ]));
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(authenticator.credentialId.length);
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | FLAG_AT]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    idLength,
    authenticator.credentialId,
    coseKey,
  ]);
  const attestationObject = cbor(new Map([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authData],
  ]));
  return {
    id: authenticator.id,
    rawId: authenticator.id,
    type: "public-key",
    response: {
      clientDataJSON: clientData("webauthn.create", options.challenge, origin).toString("base64url"),
      attestationObject: attestationObject.toString("base64url"),
      transports: ["internal", "hybrid"],
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

function getAssertion(authenticator, options, { origin, uv = true, userId, signer }) {
  authenticator.signCount += 1;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(authenticator.signCount);
  const authData = Buffer.concat([
    crypto.createHash("sha256").update(options.rpId).digest(),
    Buffer.from([FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS]),
    counter,
  ]);
  const clientDataJSON = clientData("webauthn.get", options.challenge, origin);
  const signature = crypto.sign(
    "sha256",
    Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()]),
    (signer ?? authenticator).privateKey,
  );
  return {
    id: authenticator.id,
    rawId: authenticator.id,
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      signature: signature.toString("base64url"),
      userHandle: Buffer.from(String(userId)).toString("base64url"),
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
async function registerVerifiedUser(label) {
  const email = `mobile-passkey-${label}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}@test.local`;
  const password = "password-123";
  const cookie = { value: "" };
  const registered = await request("POST", "/auth/register", {
    body: { name: `Mobile Passkey ${label}`, email, password },
    cookie,
  });
  check(`${label}: registration succeeds`, registered.status === 200, JSON.stringify(registered.data));
  const verified = await request(
    "GET",
    `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`,
    { cookie },
  );
  check(`${label}: email verification succeeds`, verified.status === 200);
  const login = await request("POST", "/auth/login", { body: { email, password }, cookie });
  check(`${label}: first login requires 2FA setup`, login.data?.requires2faSetup === true);
  return { email, password, cookie };
}

async function enableTotp(cookie) {
  const setup = await request("GET", "/auth/2fa/setup", { cookie });
  const enabled = await request("POST", "/auth/2fa/enable", { body: { code: currentTotp(setup.data.secret) }, cookie });
  check("TOTP enrolment succeeds", enabled.status === 200);
  const me = await request("GET", "/auth/me", { cookie });
  return { secret: setup.data.secret, userId: me.data.user.id };
}

async function main() {
  // ── Domain association files ──
  const aasa = await request("GET", "/.well-known/apple-app-site-association", { base: ROOT });
  check("AASA lists the iOS app for webcredentials", aasa.status === 200
    && JSON.stringify(aasa.data) === JSON.stringify({
      webcredentials: { apps: [`${process.env.MOBILE_IOS_TEAM_ID}.${process.env.MOBILE_IOS_BUNDLE_ID}`] },
    }), JSON.stringify(aasa.data));
  const links = await request("GET", "/.well-known/assetlinks.json", { base: ROOT });
  check("assetlinks grants the Android app passkey access", links.status === 200
    && links.data?.[0]?.relation?.includes("delegate_permission/common.get_login_creds")
    && links.data[0].target.package_name === process.env.MOBILE_ANDROID_PACKAGE
    && links.data[0].target.sha256_cert_fingerprints[0] === process.env.MOBILE_ANDROID_CERT_SHA256.toUpperCase());

  // ── A TOTP account signs in with password on mobile and adds a passkey ──
  const totpUser = await registerVerifiedUser("totp");
  const { secret, userId } = await enableTotp(totpUser.cookie);
  const pending = await request("POST", "/auth/mobile-login", {
    body: { email: totpUser.email, password: totpUser.password },
  });
  check("password mobile login still returns a TOTP challenge", typeof pending.data?.pendingToken === "string");
  const session = await request("POST", "/auth/mobile-login/verify-totp", {
    body: { pendingToken: pending.data.pendingToken, code: currentTotp(secret) },
  });
  check("password + TOTP mobile login issues a bearer", typeof session.data?.token === "string");
  const bearer = session.data.token;

  check("registration needs a signed-in user",
    (await request("POST", "/auth/mobile-passkeys/registration/options", { body: {} })).status === 401);

  const phone = makeAuthenticator();
  const regOptions = await request("POST", "/auth/mobile-passkeys/registration/options", { body: {}, bearer });
  check("registration options are issued", regOptions.status === 200 && typeof regOptions.data?.challengeToken === "string");
  check("native passkeys must be discoverable and user-verified",
    regOptions.data.options.authenticatorSelection.residentKey === "required"
    && regOptions.data.options.authenticatorSelection.userVerification === "required");
  check("registration RP ID is the web domain", regOptions.data.options.rp.id === RP_ID);

  const androidCredential = createCredential(phone, regOptions.data.options, { origin: ANDROID_ORIGIN });
  const registered = await request("POST", "/auth/mobile-passkeys/registration/verify", {
    body: { challengeToken: regOptions.data.challengeToken, credential: androidCredential },
    bearer,
  });
  check("an Android app passkey registers", registered.status === 200 && registered.data?.ok === true, JSON.stringify(registered.data));
  const reused = await request("POST", "/auth/mobile-passkeys/registration/verify", {
    body: { challengeToken: regOptions.data.challengeToken, credential: androidCredential },
    bearer,
  });
  check("a registration challenge cannot be reused",
    reused.status === 400 && reused.data?.code === "MOBILE_PASSKEY_CHALLENGE_INVALID");

  const againOptions = await request("POST", "/auth/mobile-passkeys/registration/options", { body: {}, bearer });
  check("the existing passkey is excluded from new registrations",
    againOptions.data.options.excludeCredentials?.some((credential) => credential.id === phone.id));
  const duplicate = await request("POST", "/auth/mobile-passkeys/registration/verify", {
    body: {
      challengeToken: againOptions.data.challengeToken,
      credential: createCredential(phone, againOptions.data.options, { origin: ANDROID_ORIGIN }),
    },
    bearer,
  });
  check("registering the same passkey twice is a conflict", duplicate.status === 409, JSON.stringify(duplicate));

  const strangerOptions = await request("POST", "/auth/mobile-passkeys/registration/options", { body: {}, bearer });
  const strangerApp = createCredential(makeAuthenticator(), strangerOptions.data.options, {
    origin: `android:apk-key-hash:${crypto.randomBytes(32).toString("base64url")}`,
  });
  check("an app signed with another key cannot register", (await request("POST", "/auth/mobile-passkeys/registration/verify", {
    body: { challengeToken: strangerOptions.data.challengeToken, credential: strangerApp },
    bearer,
  })).status === 400);

  const listed = await request("GET", "/auth/passkeys", { bearer });
  check("the new passkey is listed for the account", listed.data?.passkeys?.length === 1);

  // ── Sign in with the passkey on iOS ──
  const authOptions = await request("POST", "/auth/mobile-passkeys/authentication/options", { body: {} });
  check("sign-in options are issued without an account hint",
    authOptions.status === 200 && !(authOptions.data.options.allowCredentials?.length));
  check("sign-in requires user verification", authOptions.data.options.userVerification === "required");
  check("sign-in options carry the web setup link", authOptions.data.webSetupUrl === `${WEB_ORIGIN}/settings`);

  const assertion = getAssertion(phone, authOptions.data.options, { origin: IOS_ORIGIN, userId });
  const signedIn = await request("POST", "/auth/mobile-passkeys/authenticate", {
    body: { challengeToken: authOptions.data.challengeToken, credential: assertion },
  });
  check("a passkey hands over to the TOTP step", signedIn.status === 200 && typeof signedIn.data?.pendingToken === "string",
    JSON.stringify(signedIn.data));
  check("a passkey alone never issues a bearer", signedIn.data?.token === undefined);

  const replay = await request("POST", "/auth/mobile-passkeys/authenticate", {
    body: { challengeToken: authOptions.data.challengeToken, credential: assertion },
  });
  check("a sign-in challenge cannot be replayed",
    replay.status === 400 && replay.data?.code === "MOBILE_PASSKEY_CHALLENGE_INVALID");

  const wrongCode = await request("POST", "/auth/mobile-login/verify-totp", {
    body: { pendingToken: signedIn.data.pendingToken, code: currentTotp(secret) === "000000" ? "111111" : "000000" },
  });
  check("the TOTP step still rejects a wrong code", wrongCode.status === 401);
  const completed = await request("POST", "/auth/mobile-login/verify-totp", {
    body: { pendingToken: signedIn.data.pendingToken, code: currentTotp(secret) },
  });
  check("passkey + TOTP issues a bearer", completed.status === 200 && typeof completed.data?.token === "string");
  const me = await request("GET", "/auth/me", { bearer: completed.data.token });
  check("the bearer belongs to the passkey's account", me.data?.user?.email === totpUser.email);

  async function attempt(overrides) {
    const options = await request("POST", "/auth/mobile-passkeys/authentication/options", { body: {} });
    const credential = getAssertion(overrides.authenticator ?? phone, options.data.options, {
      origin: IOS_ORIGIN, userId, ...overrides,
    });
    return request("POST", "/auth/mobile-passkeys/authenticate", {
      body: { challengeToken: options.data.challengeToken, credential },
    });
  }
  const androidSignIn = await attempt({ origin: ANDROID_ORIGIN });
  check("the Android app can sign in too", typeof androidSignIn.data?.pendingToken === "string");
  check("a passkey without user verification is refused", (await attempt({ uv: false })).status === 401);
  check("another website's origin is refused", (await attempt({ origin: "https://evil.example" })).status === 401);
  check("a forged signature is refused", (await attempt({ signer: makeAuthenticator() })).status === 401);
  check("a mismatched user handle is refused", (await attempt({ userId: userId + 1 })).status === 401);
  const unknown = await attempt({ authenticator: makeAuthenticator() });
  check("an unregistered passkey gets the web setup link",
    unknown.status === 401 && unknown.data?.webSetupUrl === `${WEB_ORIGIN}/settings`);

  // ── An account without TOTP is sent to web setup, as with a password ──
  const setupUser = await registerVerifiedUser("setup");
  const webOptions = await request("POST", "/auth/passkeys/registration/options", { body: {}, cookie: setupUser.cookie });
  const laptop = makeAuthenticator();
  const webRegistered = await request("POST", "/auth/passkeys/registration/verify", {
    body: createCredential(laptop, webOptions.data, { origin: WEB_ORIGIN }),
    cookie: setupUser.cookie,
  });
  check("a setup-pending web user registers a passkey", webRegistered.data?.requires2faSetup === true);
  const setupUserId = Number(Buffer.from(webOptions.data.user.id, "base64url").toString("utf8"));
  const setupOptions = await request("POST", "/auth/mobile-passkeys/authentication/options", { body: {} });
  const setupSignIn = await request("POST", "/auth/mobile-passkeys/authenticate", {
    body: {
      challengeToken: setupOptions.data.challengeToken,
      credential: getAssertion(laptop, setupOptions.data.options, { origin: IOS_ORIGIN, userId: setupUserId }),
    },
  });
  check("a passkey account without TOTP is sent to web setup",
    setupSignIn.status === 200 && setupSignIn.data?.requires2faSetup === true
    && setupSignIn.data.setupUrl === `${WEB_ORIGIN}/settings`
    && setupSignIn.data.pendingToken === undefined && setupSignIn.data.token === undefined,
    JSON.stringify(setupSignIn.data));

  console.log(`mobile passkey checks passed: ${passed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
