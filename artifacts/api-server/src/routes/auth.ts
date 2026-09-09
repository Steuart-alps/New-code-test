import { Router } from "express";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import QRCode from "qrcode";
import { generateSecret, generateToken, verifyToken, keyUri } from "../lib/totp";
import { getUserWithClientByEmail } from "../lib/auth";
import { verifyPassword, hashPassword } from "../lib/auth";
import { getUserById } from "../lib/auth";
import { requireAuth } from "../middleware/requireAuth";
import { loginRateLimit, makeLoginRateLimit, registrationRateLimit } from "../lib/loginRateLimit";
import { db } from "@workspace/db";
import { usersTable, passwordResetTokensTable, clientsTable, consultantClientsTable } from "@workspace/db/schema";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { sendSystemEmail, getPublicAppUrl } from "../lib/email";
import { getUncachableStripeClient } from "../lib/stripeClient";
import { getPerSitePrice, getServicePrice, countClientSites, quantityForSiteCount } from "../lib/billing";
import { ADDON_KEYS, BUNDLE_KEY, getEntitledServices } from "../lib/services";
import { seedStarterContent } from "../lib/seedStarterContent";
import { isClientBillingLocked } from "../lib/trialLock";
import { logger } from "../lib/logger";
import { nameIsClean } from "../lib/contentFilter";

const router = Router();

// ── 2FA recovery codes ──────────────────────────────────────────────────────
// Ten one-time recovery codes (format XXXX-XXXX-XXXX, no ambiguous chars) are
// issued when 2FA is enabled or regenerated. Only SHA-256 hashes are stored.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateRecoveryCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, generateRecoveryCode);
}

async function replaceRecoveryCodes(userId: number): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM totp_recovery_codes WHERE user_id = ${userId}`);
    for (const code of codes) {
      await tx.execute(sql`
        INSERT INTO totp_recovery_codes (user_id, code_hash)
        VALUES (${userId}, ${hashRecoveryCode(code)})
      `);
    }
  });
  return codes;
}

async function consumeRecoveryCode(userId: number, code: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE totp_recovery_codes
    SET used_at = now()
    WHERE id = (
      SELECT id
      FROM totp_recovery_codes
      WHERE user_id = ${userId}
        AND code_hash = ${hashRecoveryCode(code)}
        AND used_at IS NULL
      LIMIT 1
    ) AND used_at IS NULL
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/auth/login", loginRateLimit, async (req, res) => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid email or password" });
    return;
  }

  const result = await getUserWithClientByEmail(body.data.email);
  if (!result || !result.user.active) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await verifyPassword(body.data.password, result.user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const verificationStatus = await db.execute(sql`
    SELECT email_verified FROM users WHERE id = ${result.user.id} LIMIT 1
  `);
  const emailVerified = (verificationStatus.rows?.[0] as { email_verified?: boolean } | undefined)?.email_verified;
  if (emailVerified === false) {
    res.status(403).json({
      error: "Please verify your email address before signing in.",
      requiresEmailVerification: true,
    });
    return;
  }

  // If 2FA is enabled, hold the session in a pending state and ask the client
  // to supply a TOTP code before completing the login.
  if (result.user.totpEnabled && result.user.totpSecret) {
    (req.session as any).pending2faUserId = result.user.id;
    res.json({ requires2fa: true });
    return;
  }

  req.session.userId = result.user.id;

  const { passwordHash: _, totpSecret: __, totpRecoveryHash: ___, ...safeUser } = result.user;
  let billingLocked = false;
  let services: "all" | string[] = "all";
  if (safeUser.clientId != null) {
    try {
      billingLocked = await isClientBillingLocked(safeUser.clientId);
      services = await getEntitledServices(safeUser.clientId);
    } catch {
      // Fail open — login must never break on a billing check.
    }
  }
  res.json({
    user: safeUser,
    client: result.client,
    billingLocked,
    services,
  });
});

// POST /auth/2fa/verify — complete a pending 2FA login by supplying a TOTP code
router.post("/auth/2fa/verify", loginRateLimit, async (req, res) => {
  const pendingUserId = (req.session as any).pending2faUserId;
  if (!pendingUserId) { res.status(400).json({ error: "No pending 2FA session" }); return; }

  const { code } = req.body as { code?: string };
  const trimmed = (code ?? "").trim();
  if (!trimmed) {
    res.status(400).json({ error: "Please enter a code" }); return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, pendingUserId)).limit(1);
  if (!user || !user.totpEnabled || !user.totpSecret) {
    res.status(400).json({ error: "Invalid session" }); return;
  }

  if (/^\d{6}$/.test(trimmed)) {
    if (!verifyToken(trimmed, user.totpSecret)) {
      res.status(401).json({ error: "Incorrect code. Please try again." }); return;
    }
  } else {
    // Not a 6-digit TOTP — treat as a one-time recovery code.
    if (!await consumeRecoveryCode(user.id, trimmed)) {
      res.status(401).json({ error: "Incorrect code. Please try again." }); return;
    }
  }

  delete (req.session as any).pending2faUserId;
  req.session.userId = user.id;

  const withClient = await getUserWithClientByEmail(user.email);
  const { passwordHash: _p, totpSecret: _t, totpRecoveryHash: _r, ...safeUser } = user;
  let billingLocked = false;
  let services: "all" | string[] = "all";
  if (user.clientId != null) {
    try {
      billingLocked = await isClientBillingLocked(user.clientId);
      services = await getEntitledServices(user.clientId);
    } catch {}
  }
  res.json({
    user: safeUser,
    client: withClient?.client ?? null,
    billingLocked,
    services,
  });
});

// GET /auth/2fa/setup — generate a fresh TOTP secret + QR code for the signed-in user
router.get("/auth/2fa/setup", requireAuth, async (req, res) => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const secret = generateSecret();
  const otpauth = keyUri(user.email, "ComplyTrack", secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  (req.session as any).pendingTotpSecret = secret;

  res.json({ secret, qrDataUrl });
});

// POST /auth/2fa/enable — verify a TOTP code against the pending secret and save it
router.post("/auth/2fa/enable", requireAuth, async (req, res) => {
  const pendingSecret = (req.session as any).pendingTotpSecret as string | undefined;
  if (!pendingSecret) {
    res.status(400).json({ error: "No setup in progress. Start setup first." }); return;
  }
  const { code } = req.body as { code?: string };
  if (!code || !/^\d{6}$/.test(code.trim())) {
    res.status(400).json({ error: "Please enter a 6-digit code" }); return;
  }
  if (!verifyToken(code.trim(), pendingSecret)) {
    res.status(401).json({ error: "Incorrect code — please check your authenticator app." }); return;
  }
  const recoveryCodes = await replaceRecoveryCodes(req.currentUser!.id);
  await db.update(usersTable)
    .set({
      totpSecret: pendingSecret,
      totpEnabled: true,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, req.currentUser!.id));
  delete (req.session as any).pendingTotpSecret;
  // Plaintext codes are returned exactly once — only their hashes are stored.
  res.json({ ok: true, recoveryCodes });
});

// POST /auth/2fa/recovery-codes/regenerate — replace all remaining codes.
router.post("/auth/2fa/recovery-codes/regenerate", requireAuth, async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "Password required" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user || !user.totpEnabled) { res.status(400).json({ error: "Two-factor authentication is not enabled" }); return; }
  if (!await verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Incorrect password" }); return;
  }
  const recoveryCodes = await replaceRecoveryCodes(user.id);
  res.json({ recoveryCodes });
});

// POST /auth/2fa/recover — account recovery for users locked out of their authenticator app.
// Accepts email + password + recovery code. On success, clears 2FA and returns a new session.
router.post("/auth/2fa/recover", loginRateLimit, async (req, res) => {
  const { email, password, recoveryCode } = req.body as { email?: string; password?: string; recoveryCode?: string };
  if (!email || !password || !recoveryCode) {
    res.status(400).json({ error: "Email, password and recovery code are required" }); return;
  }

  const result = await getUserWithClientByEmail(email.trim().toLowerCase());
  if (!result || !result.user.active) {
    res.status(400).json({ error: "Invalid credentials or recovery code" }); return;
  }

  const validPassword = await verifyPassword(password, result.user.passwordHash);
  if (!validPassword) {
    res.status(400).json({ error: "Invalid credentials or recovery code" }); return;
  }

  if (!result.user.totpEnabled) {
    res.status(400).json({ error: "Two-factor authentication is not enabled on this account" }); return;
  }

  if (!await consumeRecoveryCode(result.user.id, recoveryCode.trim())) {
    res.status(400).json({ error: "Invalid credentials or recovery code" }); return;
  }

  // Establish a session so they are immediately logged in
  req.session.userId = result.user.id;

  let billingLocked = false;
  let services: "all" | string[] = "all";
  if (result.user.clientId != null) {
    try {
      billingLocked = await isClientBillingLocked(result.user.clientId);
      services = await getEntitledServices(result.user.clientId);
    } catch {}
  }

  const { passwordHash: _p, totpSecret: _t, totpRecoveryHash: _r, ...safeUser } = result.user;
  res.json({
    user: safeUser,
    client: result.client ?? null,
    billingLocked,
    services,
  });
});

// POST /auth/2fa/disable — verify the user's password then clear TOTP
router.post("/auth/2fa/disable", requireAuth, async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "Password required" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (!await verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Incorrect password" }); return;
  }
  await db.update(usersTable)
    .set({ totpSecret: null, totpEnabled: false, totpRecoveryHash: null, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));
  await db.execute(sql`DELETE FROM totp_recovery_codes WHERE user_id = ${user.id}`);
  res.json({ ok: true });
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const user = await getUserById(req.currentUser!.id);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let client = null;
  if (user.clientId) {
    const { db } = await import("@workspace/db");
    const { clientsTable } = await import("@workspace/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(clientsTable).where(eq(clientsTable.id, user.clientId));
    client = rows[0] ?? null;
  }

  let billingLocked = false;
  let services: "all" | string[] = "all";
  if (user.clientId != null) {
    try {
      billingLocked = await isClientBillingLocked(user.clientId);
      services = await getEntitledServices(user.clientId);
    } catch {
      // Fail open — never block /me on a billing check.
    }
  }

  const { totpSecret: _s, ...safeUser } = user;
  res.json({ user: safeUser, client, billingLocked, services });
});

const ForgotPasswordBody = z.object({
  email: z.string().email(),
});

router.post("/auth/forgot-password", async (req, res) => {
  const body = ForgotPasswordBody.safeParse(req.body);
  if (!body.success) {
    res.json({ ok: true });
    return;
  }

  const result = await getUserWithClientByEmail(body.data.email);

  if (result && result.user.active) {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);

    await db.insert(passwordResetTokensTable).values({
      userId: result.user.id,
      token,
      expiresAt,
    });

    const appUrl = getPublicAppUrl();
    const resetUrl = `${appUrl}/reset-password?token=${token}`;

    try {
      await sendSystemEmail({
        to: result.user.email,
        subject: "Reset your password",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1e293b;">Password Reset Request</h2>
            <p>Hi ${result.user.name},</p>
            <p>We received a request to reset the password for your account. Click the button below to choose a new password. This link will expire in <strong>1 hour</strong>.</p>
            <p style="margin: 24px 0;">
              <a href="${resetUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Reset Password</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #2563eb;">${resetUrl}</p>
            <p>If you did not request a password reset, you can safely ignore this email.</p>
            <p>Best regards,<br><strong>ComplyTrack</strong></p>
          </div>
        `,
        text: `Hi ${result.user.name},\n\nWe received a request to reset your password. Use the link below (expires in 1 hour):\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.\n\nBest regards,\nComplyTrack`,
      });
    } catch (err) {
      req.log.error({ err }, "Failed to send password reset email");
    }
  }

  res.json({ ok: true });
});

const ResetPasswordBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

// Guard token-guessing on reset-password: an invalid/expired token returns 400
// (not 401), so count 400 as a failed attempt here in addition to 401.
const resetPasswordRateLimit = makeLoginRateLimit({
  namespace: "reset-password",
  failureStatuses: [400, 401],
});

router.post("/auth/reset-password", resetPasswordRateLimit, async (req, res) => {
  const body = ResetPasswordBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const [tokenRow] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(
      and(
        eq(passwordResetTokensTable.token, body.data.token),
        gt(passwordResetTokensTable.expiresAt, new Date()),
        isNull(passwordResetTokensTable.usedAt),
      ),
    )
    .limit(1);

  if (!tokenRow) {
    res.status(400).json({ error: "This reset link is invalid or has expired." });
    return;
  }

  const passwordHash = await hashPassword(body.data.password);

  await db
    .update(usersTable)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(usersTable.id, tokenRow.userId));

  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokensTable.id, tokenRow.id));

  res.json({ ok: true });
});

const BUSINESS_TYPES = [
  "hotel_accommodation",
  "holiday_park_campsite",
  "leisure_sports_centre",
  "restaurant_cafe_pub",
  "care_home_healthcare",
  "nursery_school",
  "offices_commercial",
  "retail",
  "pest_control",
  "other",
] as const;

const RegisterBody = z.object({
  name: z.string().min(2).refine(nameIsClean, { message: "Please use an appropriate name." }),
  orgName: z.string().min(1).max(200).optional(),
  email: z.string().email(),
  password: z.string().min(8),
  businessType: z.enum(BUSINESS_TYPES).optional(),
  priceId: z.string().optional(),
  promoCode: z.string().optional(),
  services: z.array(z.enum(ADDON_KEYS)).optional(),
  bundle: z.boolean().optional(),
});

router.post("/auth/register", registrationRateLimit, async (req, res) => {
  const body = RegisterBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Please provide a valid name, email, and password (min 8 characters)." });
    return;
  }

  const { name, orgName, email, password, businessType, promoCode, services: requestedServices, bundle } = body.data;
  // Use the explicitly provided organisation name for the client record; fall
  // back to the user's own name if omitted (e.g. API callers / older clients).
  const clientName = (orgName ?? "").trim() || name;

  const existing = await getUserWithClientByEmail(email);
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists." });
    return;
  }

  const passwordHash = await hashPassword(password);

  // Provision a default "business" (client) for the new account so the user has
  // somewhere to put sites, categories, and compliance checks. The slug is
  // derived from the email and made unique to avoid collisions with other
  // self-signups using similar local parts.
  const slugBase = (email.split("@")[0] || "business")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 32) || "business";
  const slug = `${slugBase}-${randomBytes(3).toString("hex")}`;

  let clientId: number | null = null;
  try {
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const [client] = await db
      .insert(clientsTable)
      .values({
        name: clientName, slug, primaryColor: "#6366f1", active: true, trialEndsAt,
        ...(businessType ? { businessType } : {}),
        // Remember the modules picked on the pricing page so the post-trial
        // checkout can pre-tick them. `["bundle"]` marks a full-bundle pick.
        ...(bundle ? { selectedServices: ["bundle"] }
          : requestedServices && requestedServices.length > 0 ? { selectedServices: requestedServices } : {}),
      } as any)
      .returning();
    clientId = client.id;
  } catch (err) {
    logger.error({ err, email }, "Failed to create default client during registration");
  }

  const [user] = await db
    .insert(usersTable)
    .values({ name, email, passwordHash, role: "consultant", clientId, subscriptionStatus: "trial" })
    .returning();

  // New self-registrations must confirm control of their email address before
  // receiving an authenticated session. Existing accounts remain verified via
  // the migration default, so this is backwards-compatible.
  const verificationToken = randomBytes(32).toString("hex");
  const verificationHash = createHash("sha256").update(verificationToken).digest("hex");
  await db.execute(sql`
    UPDATE users
    SET email_verified = false,
        email_verification_token = ${verificationHash},
        email_verification_expires_at = ${new Date(Date.now() + 24 * 60 * 60 * 1000)}
    WHERE id = ${user.id}
  `);

  // Link the new owner to their auto-provisioned business so tenant access
  // checks (consultant_clients membership) recognise it.
  if (clientId !== null) {
    await db
      .insert(consultantClientsTable)
      .values({ userId: user.id, clientId })
      .onConflictDoNothing();
  }

  // Pre-populate the new business with starter categories and example
  // compliance checks so the dashboard isn't empty on first login. All seeded
  // content is fully editable / deletable.
  if (clientId !== null) {
    await seedStarterContent(clientId);
  }

  // Send the verification email — best-effort, never blocks account creation.
  try {
    const appUrl = getPublicAppUrl();
    const verifyUrl = `${appUrl.replace(/\/$/, "")}/verify-email?token=${verificationToken}`;
    await sendSystemEmail({
      to: user.email,
      subject: "Verify your ComplyTrack email address",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">Verify your email address</h2>
          <p>Hi ${name},</p>
          <p>Thanks for signing up for ComplyTrack. Please confirm your email address to activate your account.</p>
          <p style="margin: 24px 0;">
            <a href="${verifyUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Verify email address</a>
          </p>
          <p>This link expires in 24 hours. If you did not create this account, you can ignore this email.</p>
          <p>Best regards,<br><strong>ComplyTrack</strong></p>
        </div>
      `,
      text: `Hi ${name},\n\nPlease verify your ComplyTrack email address by opening this link:\n${verifyUrl}\n\nThis link expires in 24 hours. If you did not create this account, you can ignore this email.\n\nBest regards,\nComplyTrack`,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to send welcome email");
  }

  // Create a Stripe customer in the background so billing setup later is
  // seamless. Failure here never blocks account creation.
  if (clientId !== null) {
    getUncachableStripeClient()
      .then(stripe => stripe.customers.create({
        name,
        email,
        metadata: { userId: String(user.id), clientId: String(clientId) },
      }))
      .then(async customer => {
        await db.update(usersTable)
          .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
          .where(eq(usersTable.id, user.id));
        await db.update(clientsTable)
          .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
          .where(eq(clientsTable.id, clientId!));
      })
      .catch(err => logger.warn({ err }, "Background Stripe customer creation failed — will retry at billing setup"));
  }

  const safeUser = { id: user.id, email: user.email, name: user.name, role: user.role };
  res.json({
    user: safeUser,
    requiresEmailVerification: true,
    // The integration suite has no mailbox, so expose the one-time token only
    // in the non-production test environment. Never expose it in production.
    ...(process.env.NODE_ENV === "test" ? { verificationToken } : {}),
  });
});

// GET /auth/verify-email?token=... — confirm a new self-registered address.
router.get("/auth/verify-email", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    res.status(400).json({ error: "Invalid verification link." });
    return;
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await db.execute(sql`
    SELECT id
    FROM users
    WHERE email_verification_token = ${tokenHash}
      AND email_verification_expires_at > now()
      AND email_verified = false
    LIMIT 1
  `);
  const user = (result.rows ?? [])[0] as { id: number } | undefined;
  if (!user) {
    res.status(400).json({ error: "This verification link is invalid or has expired." });
    return;
  }

  await db.execute(sql`
    UPDATE users
    SET email_verified = true,
        email_verification_token = NULL,
        email_verification_expires_at = NULL,
        updated_at = now()
    WHERE id = ${user.id}
  `);
  res.json({ verified: true });
});

// POST /auth/resend-verification — generic response prevents email enumeration.
router.post("/auth/resend-verification", registrationRateLimit, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (email) {
    const result = await db.execute(sql`
      SELECT id, name, email, email_verified
      FROM users
      WHERE lower(email) = ${email}
      LIMIT 1
    `);
    const user = (result.rows ?? [])[0] as {
      id: number;
      name: string;
      email: string;
      email_verified: boolean;
    } | undefined;

    if (user && !user.email_verified) {
      const verificationToken = randomBytes(32).toString("hex");
      const verificationHash = createHash("sha256").update(verificationToken).digest("hex");
      await db.execute(sql`
        UPDATE users
        SET email_verification_token = ${verificationHash},
            email_verification_expires_at = ${new Date(Date.now() + 24 * 60 * 60 * 1000)}
        WHERE id = ${user.id}
      `);
      try {
        const verifyUrl = `${getPublicAppUrl().replace(/\/$/, "")}/verify-email?token=${verificationToken}`;
        await sendSystemEmail({
          to: user.email,
          subject: "Verify your ComplyTrack email address",
          html: `<p>Hi ${user.name},</p><p><a href="${verifyUrl}">Verify your email address</a></p><p>This link expires in 24 hours.</p>`,
          text: `Verify your ComplyTrack email address: ${verifyUrl}\n\nThis link expires in 24 hours.`,
        });
      } catch (err) {
        logger.warn({ err }, "Failed to resend verification email");
      }
    }
  }
  res.json({ sent: true });
});

// ─── Mobile auth ─────────────────────────────────────────────────────────────

const MobileLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const MobileTotpVerificationBody = z.object({
  pendingToken: z.string().min(1),
  code: z.string().min(1),
});

const MOBILE_LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hashMobileLoginChallenge(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function issueMobileSession(user: {
  id: number;
  email: string;
  name: string;
  role: string;
  clientId: number | null;
}) {
  const token = randomBytes(32).toString("hex");
  // 90-day expiry — long enough for regular field use, refreshed on each login
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  await db.execute(sql`
    INSERT INTO mobile_sessions (user_id, token, expires_at)
    VALUES (${user.id}, ${token}, ${expiresAt})
  `);

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clientId: user.clientId ?? null,
    },
  };
}

/**
 * POST /api/auth/mobile-login
 * Authenticates with email + password and returns a long-lived bearer token.
 * Tokens are stored in mobile_sessions (created by runRuntimeMigrations).
 */
router.post("/auth/mobile-login", loginRateLimit, async (req, res) => {
  const body = MobileLoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid email or password" });
    return;
  }

  const result = await getUserWithClientByEmail(body.data.email);
  if (!result || !result.user.active) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await verifyPassword(body.data.password, result.user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const verificationStatus = await db.execute(sql`
    SELECT email_verified FROM users WHERE id = ${result.user.id} LIMIT 1
  `);
  const emailVerified = (verificationStatus.rows?.[0] as { email_verified?: boolean } | undefined)?.email_verified;
  if (emailVerified === false) {
    res.status(403).json({
      error: "Please verify your email address before signing in.",
      requiresEmailVerification: true,
    });
    return;
  }

  // Do not issue a bearer token until a second request proves possession of the
  // user's authenticator. Only a digest of the short-lived challenge is stored.
  if (result.user.totpEnabled && result.user.totpSecret) {
    const pendingToken = randomBytes(32).toString("hex");
    const tokenHash = hashMobileLoginChallenge(pendingToken);
    const expiresAt = new Date(Date.now() + MOBILE_LOGIN_CHALLENGE_TTL_MS);
    await db.execute(sql`DELETE FROM mobile_login_challenges WHERE expires_at <= now()`);
    await db.execute(sql`
      INSERT INTO mobile_login_challenges (user_id, token_hash, expires_at)
      VALUES (${result.user.id}, ${tokenHash}, ${expiresAt})
    `);
    res.json({ pendingToken });
    return;
  }

  res.json(await issueMobileSession(result.user));
});

/**
 * POST /api/auth/mobile-login/verify-totp
 * Exchanges a valid five-minute login challenge and 2FA code for a bearer token.
 */
router.post("/auth/mobile-login/verify-totp", loginRateLimit, async (req, res) => {
  const body = MobileTotpVerificationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Pending token and verification code are required" });
    return;
  }

  const tokenHash = hashMobileLoginChallenge(body.data.pendingToken);
  const verification = await db.transaction(async (tx) => {
    // Lock the challenge for the full exchange so concurrent requests cannot
    // consume recovery factors or issue more than one bearer session.
    const challengeResult = await tx.execute(sql`
      SELECT
        c.id AS challenge_id,
        u.id,
        u.email,
        u.name,
        u.role,
        u.client_id,
        u.active,
        u.totp_enabled,
        u.totp_secret
      FROM mobile_login_challenges c
      JOIN users u ON u.id = c.user_id
      WHERE c.token_hash = ${tokenHash}
        AND c.expires_at > now()
      LIMIT 1
      FOR UPDATE OF c
    `);
    const user = challengeResult.rows?.[0] as {
      challenge_id: number;
      id: number;
      email: string;
      name: string;
      role: string;
      client_id: number | null;
      active: boolean;
      totp_enabled: boolean;
      totp_secret: string | null;
    } | undefined;

    if (!user || !user.active || !user.totp_enabled || !user.totp_secret) {
      return { status: "invalid-challenge" as const };
    }

    const code = body.data.code.trim();
    let codeIsValid: boolean;
    if (/^\d{6}$/.test(code)) {
      codeIsValid = verifyToken(code, user.totp_secret);
    } else {
      const recoveryResult = await tx.execute(sql`
        UPDATE totp_recovery_codes
        SET used_at = now()
        WHERE id = (
          SELECT id
          FROM totp_recovery_codes
          WHERE user_id = ${user.id}
            AND code_hash = ${hashRecoveryCode(code)}
            AND used_at IS NULL
          LIMIT 1
          FOR UPDATE
        ) AND used_at IS NULL
        RETURNING id
      `);
      codeIsValid = (recoveryResult.rows?.length ?? 0) > 0;
    }
    if (!codeIsValid) {
      return { status: "invalid-code" as const };
    }

    await tx.execute(sql`
      DELETE FROM mobile_login_challenges
      WHERE id = ${user.challenge_id}
    `);

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await tx.execute(sql`
      INSERT INTO mobile_sessions (user_id, token, expires_at)
      VALUES (${user.id}, ${token}, ${expiresAt})
    `);

    return {
      status: "success" as const,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        clientId: user.client_id,
      },
    };
  });

  if (verification.status === "invalid-challenge") {
    res.status(401).json({ error: "This verification request is invalid or has expired. Please sign in again." });
    return;
  }
  if (verification.status === "invalid-code") {
    res.status(401).json({ error: "Incorrect code. Please try again." });
    return;
  }

  res.json({ token: verification.token, user: verification.user });
});

/**
 * POST /api/auth/mobile-logout
 * Invalidates the current bearer token.
 */
router.post("/auth/mobile-logout", requireAuth, async (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    await db.execute(sql`DELETE FROM mobile_sessions WHERE token = ${token}`).catch(() => {});
  }
  res.status(204).send();
});

export default router;
