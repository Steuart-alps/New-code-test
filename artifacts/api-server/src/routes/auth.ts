import { Router } from "express";
import { z } from "zod";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import QRCode from "qrcode";
import { generateSecret, generateToken, verifyToken, keyUri } from "../lib/totp";
import { getUserWithClientByEmail } from "../lib/auth";
import { verifyPassword, hashPassword } from "../lib/auth";
import { getUserById } from "../lib/auth";
import { requireAuth } from "../middleware/requireAuth";
import { loginRateLimit } from "../middleware/loginRateLimit";
import { db } from "@workspace/db";
import { usersTable, passwordResetTokensTable, clientsTable, consultantClientsTable } from "@workspace/db/schema";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { sendSystemEmail } from "../lib/email";
import { getUncachableStripeClient } from "../lib/stripeClient";
import { getPerSitePrice, getServicePrice, countClientSites, quantityForSiteCount } from "../lib/billing";
import { ADDON_KEYS, BUNDLE_KEY, getEntitledServices } from "../lib/services";
import { seedStarterContent } from "../lib/seedStarterContent";
import { isClientBillingLocked } from "../lib/trialLock";
import { logger } from "../lib/logger";
import { nameIsClean } from "../lib/contentFilter";

const router = Router();

// ── 2FA recovery codes ──────────────────────────────────────────────────────
// A single one-time recovery code (format XXXX-XXXX-XXXX, no ambiguous chars)
// is issued when 2FA is enabled. Using it signs the user in and disables 2FA
// so they can re-enrol with a new device.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateRecoveryCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}

function recoveryCodeMatches(code: string, storedHash: string): boolean {
  const a = Buffer.from(hashRecoveryCode(code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
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

  // If 2FA is enabled, hold the session in a pending state and ask the client
  // to supply a TOTP code before completing the login.
  if (result.user.totpEnabled && result.user.totpSecret) {
    (req.session as any).pending2faUserId = result.user.id;
    res.json({ requires2fa: true });
    return;
  }

  req.session.userId = result.user.id;

  const { passwordHash: _, totpSecret: __, ...safeUser } = result.user;
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

  let usedRecoveryCode = false;
  if (/^\d{6}$/.test(trimmed)) {
    if (!verifyToken(trimmed, user.totpSecret)) {
      res.status(401).json({ error: "Incorrect code. Please try again." }); return;
    }
  } else {
    // Not a 6-digit TOTP — treat as a one-time recovery code.
    if (!user.totpRecoveryHash || !recoveryCodeMatches(trimmed, user.totpRecoveryHash)) {
      res.status(401).json({ error: "Incorrect code. Please try again." }); return;
    }
    // Recovery code is single-use: sign in and disable 2FA so the user can
    // re-enrol with a new device.
    usedRecoveryCode = true;
    await db.update(usersTable)
      .set({ totpSecret: null, totpEnabled: false, totpRecoveryHash: null, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
    user.totpEnabled = false;
  }

  delete (req.session as any).pending2faUserId;
  req.session.userId = user.id;

  const withClient = await getUserWithClientByEmail(user.email);
  const { passwordHash: _p, totpSecret: _t, ...safeUser } = user;
  let billingLocked = false;
  let services: "all" | string[] = "all";
  if (user.clientId != null) {
    try {
      billingLocked = await isClientBillingLocked(user.clientId);
      services = await getEntitledServices(user.clientId);
    } catch {}
  }
  res.json({
    user: { ...safeUser, totpEnabled: !usedRecoveryCode },
    client: withClient?.client ?? null,
    billingLocked,
    services,
    ...(usedRecoveryCode ? { usedRecoveryCode: true } : {}),
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
  const recoveryCode = generateRecoveryCode();
  await db.update(usersTable)
    .set({
      totpSecret: pendingSecret,
      totpEnabled: true,
      totpRecoveryHash: hashRecoveryCode(recoveryCode),
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, req.currentUser!.id));
  delete (req.session as any).pendingTotpSecret;
  // The plaintext recovery code is returned exactly once — it is stored hashed.
  res.json({ ok: true, recoveryCode });
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

    const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN}`;
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

router.post("/auth/reset-password", async (req, res) => {
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

router.post("/auth/register", async (req, res) => {
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

  // Send a branded welcome email — best-effort, never blocks signup.
  try {
    const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN}`;
    await sendSystemEmail({
      to: user.email,
      subject: "Welcome to ComplyTrack",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">Welcome to ComplyTrack</h2>
          <p>Hi ${name},</p>
          <p>Thanks for signing up — your 14-day free trial has started. Your account is ready to go and we've pre-populated some starter compliance content so you can hit the ground running.</p>
          <p style="margin: 24px 0;">
            <a href="${appUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Go to your dashboard</a>
          </p>
          <p>If you have any questions, just reply to this email — we're happy to help.</p>
          <p>Best regards,<br><strong>ComplyTrack</strong></p>
        </div>
      `,
      text: `Hi ${name},\n\nThanks for signing up — your 14-day free trial has started. Your account is ready to go.\n\nGo to your dashboard: ${appUrl}\n\nIf you have any questions, just reply to this email.\n\nBest regards,\nComplyTrack`,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to send welcome email");
  }

  // Log the user in immediately — trial has started, no card needed.
  (req.session as any).userId = user.id;

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
  res.json({ user: safeUser });
});

// ─── Mobile auth ─────────────────────────────────────────────────────────────

const MobileLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // Optional TOTP (or recovery) code for accounts with 2FA enabled. The mobile
  // flow is stateless: the client re-submits credentials together with the code.
  code: z.string().optional(),
});

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

  // 2FA: if the account has TOTP enabled, require a code. The mobile client
  // re-submits email + password + code (stateless — no pending session).
  if (result.user.totpEnabled && result.user.totpSecret) {
    const trimmed = (body.data.code ?? "").trim();
    if (!trimmed) {
      res.json({ requires2fa: true });
      return;
    }
    if (/^\d{6}$/.test(trimmed)) {
      if (!verifyToken(trimmed, result.user.totpSecret)) {
        res.status(401).json({ error: "Incorrect code. Please try again." });
        return;
      }
    } else {
      // Treat as a one-time recovery code; single-use, disables 2FA for re-enrolment.
      if (!result.user.totpRecoveryHash || !recoveryCodeMatches(trimmed, result.user.totpRecoveryHash)) {
        res.status(401).json({ error: "Incorrect code. Please try again." });
        return;
      }
      await db.update(usersTable)
        .set({ totpSecret: null, totpEnabled: false, totpRecoveryHash: null, updatedAt: new Date() })
        .where(eq(usersTable.id, result.user.id));
    }
  }

  const token = randomBytes(32).toString("hex");
  // 90-day expiry — long enough for regular field use, refreshed on each login
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  await db.execute(sql`
    INSERT INTO mobile_sessions (user_id, token, expires_at)
    VALUES (${result.user.id}, ${token}, ${expiresAt})
  `);

  const safeUser = {
    id: result.user.id,
    email: result.user.email,
    name: result.user.name,
    role: result.user.role,
    clientId: result.user.clientId ?? null,
  };
  res.json({ token, user: safeUser });
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
