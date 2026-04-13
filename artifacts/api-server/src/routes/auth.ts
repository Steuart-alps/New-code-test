import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getUserWithClientByEmail } from "../lib/auth";
import { verifyPassword, hashPassword } from "../lib/auth";
import { getUserById } from "../lib/auth";
import { requireAuth } from "../middleware/requireAuth";
import { db } from "@workspace/db";
import { usersTable, passwordResetTokensTable } from "@workspace/db/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import { sendSystemEmail } from "../lib/email";
import { getUncachableStripeClient } from "../lib/stripeClient";

const router = Router();

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/auth/login", async (req, res) => {
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

  req.session.userId = result.user.id;

  const { passwordHash: _, ...safeUser } = result.user;
  res.json({
    user: safeUser,
    client: result.client,
  });
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

  res.json({ user, client });
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
    } catch {
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

const RegisterBody = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  priceId: z.string().optional(),
  promoCode: z.string().optional(),
});

router.post("/auth/register", async (req, res) => {
  const body = RegisterBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Please provide a valid name, email, and password (min 8 characters)." });
    return;
  }

  const { name, email, password, priceId, promoCode } = body.data;

  const existing = await getUserWithClientByEmail(email);
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists." });
    return;
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(usersTable)
    .values({ name, email, passwordHash, role: "consultant", subscriptionStatus: "trial" })
    .returning();

  // Log the user in immediately
  (req.session as any).userId = user.id;

  let checkoutUrl: string | null = null;

  if (priceId) {
    try {
      const stripe = await getUncachableStripeClient();
      const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;

      const customer = await stripe.customers.create({ name, email, metadata: { userId: String(user.id) } });

      await db.update(usersTable)
        .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
        .where(eq(usersTable.id, user.id));

      // Resolve promo code if provided
      let discounts: { promotion_code: string }[] | undefined;
      if (promoCode) {
        const codes = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
        if (codes.data.length > 0) {
          discounts = [{ promotion_code: codes.data[0].id }];
        }
      }

      const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
        customer: customer.id,
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${baseUrl}/dashboard?billing=success`,
        cancel_url: `${baseUrl}/signup?cancelled=1`,
        client_reference_id: String(user.id),
        metadata: { userId: String(user.id) },
        ...(discounts ? { discounts } : { allow_promotion_codes: true }),
      };

      const session = await stripe.checkout.sessions.create(sessionParams);
      checkoutUrl = session.url;
    } catch (err) {
      console.error("Stripe checkout creation failed:", err);
    }
  }

  const safeUser = { id: user.id, email: user.email, name: user.name, role: user.role };
  res.json({ user: safeUser, checkoutUrl });
});

export default router;
