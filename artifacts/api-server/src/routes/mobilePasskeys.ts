import { Router } from "express";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { eq, sql } from "drizzle-orm";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { db } from "@workspace/db";
import { passkeysTable } from "@workspace/db/schema";
import { getUserById } from "../lib/auth";
import { getPublicAppUrl } from "../lib/email";
import { loginRateLimit, passkeyChallengeRateLimit } from "../lib/loginRateLimit";
import {
  decodePasskeyBytes,
  encodePasskeyBytes,
  getMobilePasskeyOrigins,
  getPasskeyRpId,
  getUserPasskeys,
  mobileAuthenticationOptions,
  mobileRegistrationOptionsForUser,
} from "../lib/passkeys";
import { requireAuth } from "../middleware/requireAuth";

/**
 * Native passkeys for the Expo app. The app has no cookie session, so each
 * WebAuthn challenge is stored server-side against a single-use token.
 *
 * On mobile a passkey replaces the email and password; it never replaces the
 * mandatory authenticator code. A verified passkey therefore ends in exactly
 * the same place as a correct password: a pending TOTP challenge for
 * POST /auth/mobile-login/verify-totp, or the web two-factor setup link for an
 * account without TOTP. No bearer session is ever issued here.
 */
const router = Router();

const MOBILE_PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Must match the pending-token lifetime and digest used by auth.ts for
// mobile_login_challenges, which verify-totp consumes.
const MOBILE_LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MOBILE_PASSKEY_CHALLENGE_INVALID_CODE = "MOBILE_PASSKEY_CHALLENGE_INVALID";

function sha256Hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function webSetupUrl(): string {
  return `${getPublicAppUrl().replace(/\/$/, "")}/settings`;
}

async function issueChallenge(purpose: "authentication" | "registration", userId: number | null, challenge: string) {
  const challengeToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + MOBILE_PASSKEY_CHALLENGE_TTL_MS);
  await db.execute(sql`DELETE FROM mobile_passkey_challenges WHERE expires_at <= now()`);
  await db.execute(sql`
    INSERT INTO mobile_passkey_challenges (purpose, user_id, token_hash, challenge, expires_at)
    VALUES (${purpose}, ${userId}, ${sha256Hex(challengeToken)}, ${challenge}, ${expiresAt})
  `);
  return challengeToken;
}

/** Atomically consume a challenge so each one can be answered at most once. */
async function consumeChallenge(
  purpose: "authentication" | "registration",
  challengeToken: string,
  userId: number | null,
): Promise<string | null> {
  const result = await db.execute(sql`
    DELETE FROM mobile_passkey_challenges
    WHERE token_hash = ${sha256Hex(challengeToken)}
      AND purpose = ${purpose}
      AND expires_at > now()
      AND user_id IS NOT DISTINCT FROM ${userId}
    RETURNING challenge
  `);
  const row = result.rows?.[0] as { challenge: string } | undefined;
  return row?.challenge ?? null;
}

const CeremonyBody = z.object({
  challengeToken: z.string().min(1),
  credential: z.object({ id: z.string().min(1) }).passthrough(),
});

function challengeExpired(res: any) {
  res.status(400).json({
    error: "This passkey request has expired. Please try again.",
    code: MOBILE_PASSKEY_CHALLENGE_INVALID_CODE,
  });
}

/**
 * POST /api/auth/mobile-passkeys/authentication/options
 * Starts a passkey sign-in. webSetupUrl is where a user without a passkey on
 * this phone can add one.
 */
router.post("/auth/mobile-passkeys/authentication/options", passkeyChallengeRateLimit, async (_req, res) => {
  const options = await mobileAuthenticationOptions();
  const challengeToken = await issueChallenge("authentication", null, options.challenge);
  res.json({ challengeToken, options, webSetupUrl: webSetupUrl() });
});

/**
 * POST /api/auth/mobile-passkeys/authenticate
 * Verifies the passkey assertion, then hands over to the existing mandatory
 * TOTP step exactly as a correct password would.
 */
router.post("/auth/mobile-passkeys/authenticate", loginRateLimit, async (req, res) => {
  const body = CeremonyBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid passkey response" });
    return;
  }
  const expectedChallenge = await consumeChallenge("authentication", body.data.challengeToken, null);
  if (!expectedChallenge) {
    challengeExpired(res);
    return;
  }

  const [credential] = await db
    .select()
    .from(passkeysTable)
    .where(eq(passkeysTable.credentialId, body.data.credential.id))
    .limit(1);
  if (!credential) {
    res.status(401).json({
      error: "This passkey is not registered with ComplyTrack. Sign in with your password, or add a passkey first.",
      webSetupUrl: webSetupUrl(),
    });
    return;
  }

  const userHandle = (body.data.credential as { response?: { userHandle?: unknown } }).response?.userHandle;
  if (typeof userHandle === "string" && userHandle
    && Buffer.from(userHandle, "base64url").toString("utf8") !== String(credential.userId)) {
    res.status(401).json({ error: "Passkey verification failed" });
    return;
  }

  let newCounter: number;
  try {
    const verification = await verifyAuthenticationResponse({
      response: body.data.credential as any,
      expectedChallenge,
      expectedOrigin: getMobilePasskeyOrigins(),
      expectedRPID: getPasskeyRpId(),
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: decodePasskeyBytes(credential.publicKey) as Uint8Array<ArrayBuffer>,
        counter: credential.counter,
        transports: (credential.transports ?? []) as any,
      },
    });
    if (!verification.verified) {
      res.status(401).json({ error: "Passkey verification failed" });
      return;
    }
    newCounter = verification.authenticationInfo.newCounter;
  } catch {
    res.status(401).json({ error: "Passkey verification failed" });
    return;
  }

  const user = await getUserById(credential.userId);
  if (!user || !user.active) {
    res.status(401).json({ error: "Passkey verification failed" });
    return;
  }
  await db.update(passkeysTable)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(passkeysTable.id, credential.id));

  const verificationStatus = await db.execute(sql`
    SELECT email_verified FROM users WHERE id = ${user.id} LIMIT 1
  `);
  const emailVerified = (verificationStatus.rows?.[0] as { email_verified?: boolean } | undefined)?.email_verified;
  if (emailVerified === false) {
    res.status(403).json({
      error: "Please verify your email address before signing in.",
      requiresEmailVerification: true,
    });
    return;
  }

  if (user.totpEnabled && user.totpSecret) {
    const pendingToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + MOBILE_LOGIN_CHALLENGE_TTL_MS);
    await db.execute(sql`DELETE FROM mobile_login_challenges WHERE expires_at <= now()`);
    await db.execute(sql`
      INSERT INTO mobile_login_challenges (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${sha256Hex(pendingToken)}, ${expiresAt})
    `);
    res.json({ pendingToken });
    return;
  }

  // A passkey never satisfies the mandatory authenticator requirement.
  res.json({ requires2faSetup: true, setupUrl: webSetupUrl() });
});

/**
 * POST /api/auth/mobile-passkeys/registration/options
 * Starts adding a passkey on this phone for the signed-in user.
 */
router.post("/auth/mobile-passkeys/registration/options", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const existing = await getUserPasskeys(user.id);
  const options = await mobileRegistrationOptionsForUser(user, existing);
  const challengeToken = await issueChallenge("registration", user.id, options.challenge);
  res.json({ challengeToken, options });
});

/**
 * POST /api/auth/mobile-passkeys/registration/verify
 * Saves the new passkey. Adding a passkey changes nothing about the session or
 * the mandatory authenticator code.
 */
router.post("/auth/mobile-passkeys/registration/verify", requireAuth, async (req, res) => {
  const userId = req.currentUser!.id;
  const body = CeremonyBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid passkey response" });
    return;
  }
  const expectedChallenge = await consumeChallenge("registration", body.data.challengeToken, userId);
  if (!expectedChallenge) {
    challengeExpired(res);
    return;
  }
  try {
    const verification = await verifyRegistrationResponse({
      response: body.data.credential as any,
      expectedChallenge,
      expectedOrigin: getMobilePasskeyOrigins(),
      expectedRPID: getPasskeyRpId(),
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: "Passkey registration was not verified" });
      return;
    }
    const credential = verification.registrationInfo.credential;
    await db.insert(passkeysTable).values({
      userId,
      credentialId: credential.id,
      publicKey: encodePasskeyBytes(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ? [...credential.transports] : null,
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
    });
    res.json({ ok: true });
  } catch (error: any) {
    if (error?.code === "23505" || error?.cause?.code === "23505") {
      res.status(409).json({ error: "That passkey is already registered" });
      return;
    }
    res.status(400).json({ error: "Passkey registration failed" });
  }
});

export default router;
