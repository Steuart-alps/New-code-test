import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const auth = await readFile(new URL("../src/routes/auth.ts", import.meta.url), "utf8");
const guard = await readFile(new URL("../src/middleware/requireAuth.ts", import.meta.url), "utf8");
const mandatoryUi = await readFile(new URL("../../compliance-tracker/src/pages/mandatory-two-factor.tsx", import.meta.url), "utf8");
const settingsUi = await readFile(new URL("../../compliance-tracker/src/pages/settings.tsx", import.meta.url), "utf8");
const passkeyCard = settingsUi.slice(settingsUi.indexOf("function PasskeyCard()"));
const loginUi = await readFile(new URL("../../compliance-tracker/src/pages/login.tsx", import.meta.url), "utf8");
const mobileBlock = auth.slice(auth.indexOf('router.post("/auth/mobile-login"'), auth.indexOf('router.post("/auth/mobile-login/verify-totp"'));

// A verified passkey must leave TOTP pending (or start TOTP enrolment), never
// turn into a fully authenticated session by itself, unless the user's
// business has made two-factor authentication optional.
const passkeyBlock = auth.slice(auth.indexOf('// POST /auth/passkeys/authenticate'), auth.indexOf('// POST /auth/2fa/verify'));
const registrationBlock = auth.slice(auth.indexOf('router.post("/auth/passkeys/registration/verify"'), auth.indexOf('router.get("/auth/passkeys"'));
assert.match(passkeyBlock, /pending2faUserId/);
assert.match(passkeyBlock, /pending2faSetupUserId/);
assert.equal(passkeyBlock.match(/req\.session\.userId = user\.id/g)?.length ?? 0, 1);
assert.match(passkeyBlock, /else if \(!\(await isTwoFactorRequired\(user\)\)\) \{[^}]*req\.session\.userId = user\.id;/);
assert.match(registrationBlock, /requires2faSetup: true/);
assert.doesNotMatch(registrationBlock, /setupComplete/);
assert.doesNotMatch(registrationBlock, /req\.session\.userId = userId/);

// Passkeys cannot bypass the mandatory-enrolment middleware, and /me must
// report setup for a passkey-only account.
assert.doesNotMatch(guard, /if \(passkey\)/);
assert.match(auth, /if \(!user\.totpEnabled\)/);
// The mandatory enrolment screen offers the authenticator only; passkeys are
// added from Settings, whose copy must not promise they replace the code.
assert.doesNotMatch(mandatoryUi, /passkeys\/registration/);
assert.match(passkeyCard, /do not replace two-factor authentication/);
assert.match(passkeyCard, /still enter your authenticator code/);
assert.match(passkeyCard, /Mobile sign-in supports the authenticator code \(TOTP\) only/);
assert.doesNotMatch(passkeyCard, /instead of typing a one-time code/);
assert.match(loginUi, /data\.requires2faSetup/);
assert.match(mobileBlock, /totpEnabled && result\.user\.totpSecret/);
assert.match(mobileBlock, /requires2faSetup/);

console.log("passkey mandatory-2FA regression checks passed");