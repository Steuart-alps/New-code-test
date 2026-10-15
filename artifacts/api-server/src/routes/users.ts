import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { usersTable, userRoleEnum, passwordResetTokensTable } from "@workspace/db/schema";
import { eq, and, inArray, isNull, desc, gt } from "drizzle-orm";
import { hashPassword, getUserWithClientByEmail } from "../lib/auth";
import { requireAuth, requireClientAdmin, canAccessClient } from "../middleware/requireAuth";
import { escapeHtml, sendSystemEmail, getPublicAppUrl } from "../lib/email";
import { resetTwoFactorWithAlert, deliverTwoFactorResetAlert } from "../lib/twoFactorResetAlerts";
import { hashStoredCredential, revokeUserSessions } from "../lib/sessionRevocation";
import { appendAuditEvent } from "../lib/audit";

const router = Router();

const CreateUserBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).optional(),
  name: z.string().min(1),
  role: z.enum(userRoleEnum as unknown as [string, ...string[]]).default("client_viewer"),
  clientId: z.number().nullable().optional(),
  departmentId: z.number().nullable().optional(),
  active: z.boolean().default(true),
});

/**
 * Mint a password-reset token for a freshly-created user and email them an
 * "invitation" link that reuses the forgot/reset-password token machinery.
 * Existing unused reset/setup links are superseded before the new link is sent.
 */
async function sendInviteEmail(
  user: { id: number; email: string; name: string },
  log?: { error: (o: unknown, m?: string) => void },
): Promise<boolean> {
  let tokenId: number | null = null;
  try {
    const token = randomBytes(32).toString("hex");
    // Invitation links live a little longer than a routine reset (24 hours)
    // so a newly-added user has time to act on the email.
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

    // A resend must make every older unused link invalid. The token table is
    // shared with forgot-password, so superseding all unused tokens also
    // prevents an older reset link from remaining a second valid credential.
    // Both steps share a transaction so a failed insert can't leave the user
    // with no live link and their old one already cancelled.
    tokenId = await db.transaction(async (tx) => {
      await tx.update(passwordResetTokensTable)
        .set({ usedAt: new Date() })
        .where(and(
          eq(passwordResetTokensTable.userId, user.id),
          isNull(passwordResetTokensTable.usedAt),
        ));
      // Only a digest is stored; the emailed link is the credential.
      const [inserted] = await tx.insert(passwordResetTokensTable).values({
        userId: user.id,
        token: hashStoredCredential(token),
        expiresAt,
        purpose: "invite",
      }).returning({ id: passwordResetTokensTable.id });
      return inserted.id;
    });

    const appUrl = getPublicAppUrl();
    const setupUrl = `${appUrl}/reset-password?token=${token}`;
    const safeName = escapeHtml(user.name);

    await sendSystemEmail({
      to: user.email,
      subject: "You've been invited to ComplyTrack",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">You've been invited to ComplyTrack</h2>
          <p>Hi ${safeName},</p>
          <p>An administrator has created a ComplyTrack account for you. Click the button below to set your password and get started. This link will expire in <strong>24 hours</strong>.</p>
          <p style="margin: 24px 0;">
            <a href="${setupUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Set Your Password</a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #2563eb;">${setupUrl}</p>
          <p>If you weren't expecting this invitation, you can safely ignore this email.</p>
          <p>Best regards,<br><strong>ComplyTrack</strong></p>
        </div>
      `,
      text: `Hi ${user.name},\n\nAn administrator has created a ComplyTrack account for you. Use the link below to set your password (expires in 24 hours):\n\n${setupUrl}\n\nIf you weren't expecting this invitation, you can safely ignore this email.\n\nBest regards,\nComplyTrack`,
    });
  } catch (err) {
    log?.error({ err }, "Failed to send invite email");
    // Nobody received this link, so cancel it rather than leave a live
    // credential behind, and mark it so User Management can say the email
    // wasn't delivered. The admin retries with resend-invite.
    if (tokenId !== null) {
      try {
        const now = new Date();
        await db.update(passwordResetTokensTable)
          .set({ usedAt: now, emailFailedAt: now })
          .where(eq(passwordResetTokensTable.id, tokenId));
      } catch (markErr) {
        log?.error({ err: markErr }, "Failed to cancel an undelivered invite link");
      }
    }
    return false;
  }
  return true;
}

type InvitationStatus = "pending" | "expired" | "completed" | "revoked" | "undelivered";

/**
 * Password setup state for each listed user, from their most recent setup
 * (invite) link. Only users the caller is already allowed to list are looked
 * up, and only status and times are returned, never the link itself.
 *
 * A latest invite with used_at set (and not revoked) means the password was
 * set: reset-password marks every outstanding link used when any link is
 * consumed, and a resend only cancels links older than the one it creates.
 */
type Invitation = {
  status: InvitationStatus;
  sentAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

async function invitationsFor(userIds: number[]): Promise<Map<number, Invitation>> {
  const result = new Map<number, Invitation>();
  if (userIds.length === 0) return result;
  const rows = await db
    .selectDistinctOn([passwordResetTokensTable.userId], {
      userId: passwordResetTokensTable.userId,
      createdAt: passwordResetTokensTable.createdAt,
      expiresAt: passwordResetTokensTable.expiresAt,
      usedAt: passwordResetTokensTable.usedAt,
      revokedAt: passwordResetTokensTable.revokedAt,
      emailFailedAt: passwordResetTokensTable.emailFailedAt,
    })
    .from(passwordResetTokensTable)
    .where(and(
      inArray(passwordResetTokensTable.userId, userIds),
      eq(passwordResetTokensTable.purpose, "invite"),
    ))
    .orderBy(passwordResetTokensTable.userId, desc(passwordResetTokensTable.id));
  const now = Date.now();
  for (const row of rows) {
    const status: InvitationStatus = row.revokedAt
      ? "revoked"
      : row.emailFailedAt
        ? "undelivered"
        : row.usedAt
          ? "completed"
          : row.expiresAt.getTime() > now ? "pending" : "expired";
    result.set(row.userId, {
      status,
      sentAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    });
  }
  return result;
}

const UpdateUserBody = z.object({
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  name: z.string().min(1).optional(),
  role: z.enum(userRoleEnum as unknown as [string, ...string[]]).optional(),
  departmentId: z.number().nullable().optional(),
  active: z.boolean().optional(),
  isMaintenanceManager: z.boolean().optional(),
  isDepartmentManager: z.boolean().optional(),
});

/**
 * Self-signup owners have the consultant role and belong to their business
 * like its admins, so canAccessClient alone would let a client admin take
 * over the owner's account. Only a consultant may change, remove or reset
 * the second factor of a consultant.
 */
function rejectsConsultantTarget(
  actor: { id: number; role: string },
  target: { id: number; role: string },
  res: { status: (code: number) => { json: (body: unknown) => void } },
): boolean {
  if (target.role === "consultant" && actor.role !== "consultant" && target.id !== actor.id) {
    res.status(403).json({ error: "Only an account owner can change an owner's account" });
    return true;
  }
  return false;
}

router.get("/users", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  
  let rows;
  if (user.role === "consultant") {
    const clientId = req.query.clientId ? Number(req.query.clientId) : null;
    if (clientId) {
      // enforceClientAccess already rejected unauthorized ids; check again for
      // defense in depth.
      if (!canAccessClient(req, clientId)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      rows = await db
        .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
        .from(usersTable)
        .where(eq(usersTable.clientId, clientId));
    } else {
      // No explicit client selected: list users across the clients this
      // consultant is linked to — never every user in the system.
      const allowed = Array.from(req.allowedClientIds ?? []);
      if (allowed.length === 0) {
        res.json([]);
        return;
      }
      rows = await db
        .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
        .from(usersTable)
        .where(inArray(usersTable.clientId, allowed));
    }
  } else {
    rows = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
      .from(usersTable)
      .where(eq(usersTable.clientId, user.clientId!));
  }

  const invitations = await invitationsFor(rows.map((row) => row.id));
  res.json(rows.map((row) => ({ ...row, invitation: invitations.get(row.id) ?? null })));
});

router.post("/users", requireAuth, requireClientAdmin, async (req, res) => {
  const actor = req.currentUser!;
  const body = CreateUserBody.parse(req.body);

  if (actor.role !== "consultant") {
    if (body.clientId && body.clientId !== actor.clientId) {
      res.status(403).json({ error: "Cannot create users for other clients" });
      return;
    }
    body.clientId = actor.clientId;
    if (body.role === "consultant") {
      res.status(403).json({ error: "Cannot create consultant users" });
      return;
    }
  }

  // When no password is supplied, the admin is inviting the user: create the
  // account with an unusable random password and email them a link to set
  // their own via the existing reset-password token machinery.
  const invite = !body.password;

  // One account per address (sign-in matches case-insensitively). Retrying a
  // failed invitation uses resend-invite on the existing account instead.
  const existing = await getUserWithClientByEmail(body.email);
  if (existing) {
    const sameBusiness = existing.user.clientId != null && canAccessClient(req, existing.user.clientId);
    res.status(409).json({
      error: sameBusiness
        ? `${existing.user.email} already has an account here. To send their password setup link again, use the resend button in User Management.`
        : "An account with this email already exists.",
    });
    return;
  }

  const passwordHash = await hashPassword(body.password ?? randomBytes(32).toString("hex"));
  const rows = await db
    .insert(usersTable)
    .values({
      email: body.email,
      name: body.name,
      role: body.role as typeof userRoleEnum[number],
      clientId: body.clientId ?? null,
      departmentId: body.departmentId ?? null,
      active: body.active,
      passwordHash,
    })
    .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt });

  // The account stands either way; when the invitation can't be delivered the
  // admin is told and can resend it from User Management.
  const inviteEmail = invite
    ? (await sendInviteEmail(rows[0], req.log) ? "sent" : "failed")
    : null;

  res.status(201).json({ ...rows[0], inviteEmail });
});

/**
 * The staff account a setup-link action targets, after the tenant and role
 * checks shared by resend-invite and revoke-invite. Sends the error response
 * and returns null when the caller may not act on it.
 */
async function setupLinkTarget(req: Request, res: Response, verb: string) {
  const actor = req.currentUser!;
  const id = Number(req.params.id);

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (target.id !== actor.id && !canAccessClient(req, target.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  if (target.role !== "client_staff") {
    res.status(400).json({ error: `Password setup links can only be ${verb} for staff accounts` });
    return null;
  }
  return target;
}

router.post("/users/:id/resend-invite", requireAuth, requireClientAdmin, async (req, res) => {
  const target = await setupLinkTarget(req, res, "resent");
  if (!target) return;

  const sent = await sendInviteEmail(target, req.log);
  if (!sent) {
    res.status(502).json({ error: "Unable to send the password setup link. Please try again." });
    return;
  }
  res.json({ ok: true });
});

// Cancels every live setup or reset link for a staff member without sending
// a new one, e.g. when an invitation went to the wrong address. The rows are
// kept (marked used and revoked) and the action is recorded in audit_events.
router.post("/users/:id/revoke-invite", requireAuth, requireClientAdmin, async (req, res) => {
  const target = await setupLinkTarget(req, res, "revoked");
  if (!target) return;

  const now = new Date();
  const revoked = await db.update(passwordResetTokensTable)
    .set({ usedAt: now, revokedAt: now })
    .where(and(
      eq(passwordResetTokensTable.userId, target.id),
      isNull(passwordResetTokensTable.usedAt),
      gt(passwordResetTokensTable.expiresAt, now),
    ))
    .returning({ id: passwordResetTokensTable.id, purpose: passwordResetTokensTable.purpose });
  if (revoked.length === 0) {
    res.status(409).json({ error: "There is no unused password setup link to revoke for this user." });
    return;
  }

  if (target.clientId != null) {
    await appendAuditEvent(req, {
      clientId: target.clientId,
      entityType: "user",
      entityId: target.id,
      action: "setup_link_revoked",
      metadata: { linksRevoked: revoked.length, purposes: revoked.map((row) => row.purpose) },
    });
  }
  res.json({ ok: true, revoked: revoked.length });
});

router.put("/users/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const actor = req.currentUser!;
  const id = Number(req.params.id);
  const body = UpdateUserBody.parse(req.body);

  const targetRows = await db.select().from(usersTable).where(eq(usersTable.id, id));
  const target = targetRows[0];
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (target.id !== actor.id && !canAccessClient(req, target.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (rejectsConsultantTarget(actor, target, res)) return;

  // Another user's sign-in details are never set directly: an admin who could
  // change them could take the account over. Email changes for others are
  // refused, and new passwords go through the emailed set-up link
  // (POST /users/:id/resend-invite). An unchanged email (the edit form always
  // sends it) is accepted.
  if (target.id !== actor.id) {
    if (body.email !== undefined && body.email.trim().toLowerCase() !== target.email.trim().toLowerCase()) {
      res.status(400).json({ error: "Another user's email address can't be changed here. Remove the user and invite their new address instead." });
      return;
    }
    if (body.password !== undefined) {
      res.status(400).json({ error: "Another user's password can't be set directly. Send them a password setup link instead." });
      return;
    }
  }

  // Mirrors the same restriction on POST /users: only a consultant may grant
  // the consultant role. Checked unconditionally (including self-edits, which
  // skip the canAccessClient check above) so a client_admin can't promote
  // themselves or another same-client user to consultant.
  if (actor.role !== "consultant" && body.role === "consultant") {
    res.status(403).json({ error: "Cannot assign consultant role" });
    return;
  }

  const updates: Partial<typeof usersTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.email !== undefined && target.id === actor.id) updates.email = body.email;
  if (body.name !== undefined) updates.name = body.name;
  if (body.role !== undefined) updates.role = body.role as typeof userRoleEnum[number];
  if (body.departmentId !== undefined) updates.departmentId = body.departmentId;
  if (body.active !== undefined) updates.active = body.active;
  if (body.isMaintenanceManager !== undefined) updates.isMaintenanceManager = body.isMaintenanceManager;
  if (body.isDepartmentManager !== undefined) {
    if (body.isDepartmentManager && (body.role ?? target.role) !== "client_staff") {
      res.status(400).json({ error: "Only staff can be designated department managers" });
      return;
    }
    updates.isDepartmentManager = body.isDepartmentManager;
  }
  if (body.role && body.role !== "client_staff") updates.isDepartmentManager = false;
  if (body.password) updates.passwordHash = await hashPassword(body.password);

  const rows = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt });

  // A changed password signs the user out everywhere except this session.
  if (updates.passwordHash) {
    await revokeUserSessions(id, { exceptSessionId: req.sessionID });
  }

  res.json(rows[0]);
});

router.delete("/users/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const actor = req.currentUser!;
  const id = Number(req.params.id);

  const targetRows = await db.select().from(usersTable).where(eq(usersTable.id, id));
  const target = targetRows[0];
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (target.id !== actor.id && !canAccessClient(req, target.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (rejectsConsultantTarget(actor, target, res)) return;

  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ ok: true });
});

// POST /users/:id/reset-2fa — admin clears a locked-out user's 2FA so they can
// sign in with just their password and re-enrol.
router.post("/users/:id/reset-2fa", requireAuth, requireClientAdmin, async (req, res) => {
  const actor = req.currentUser!;
  const id = Number(req.params.id);

  const targetRows = await db.select().from(usersTable).where(eq(usersTable.id, id));
  const target = targetRows[0];
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (target.id !== actor.id && !canAccessClient(req, target.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (rejectsConsultantTarget(actor, target, res)) return;

  // The reset and its security alert commit together, so the alert survives a
  // provider outage or restart. Email failure never undoes or repeats the
  // reset: it is logged and the queued alert is retried by the recovery job.
  const reset = await resetTwoFactorWithAlert(id);
  if (!reset) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  // The reset is for a lost or compromised authenticator: sign the account out
  // of every browser and phone (keeping the caller's own session).
  await revokeUserSessions(id, { exceptSessionId: req.sessionID });
  if (reset.alertId !== null) {
    try {
      await deliverTwoFactorResetAlert(reset.alertId);
    } catch (err) {
      req.log.error({ err, userId: reset.user.id, actorId: actor.id, alertId: reset.alertId },
        "Failed to send two-factor reset security notification; queued for retry");
    }
  }
  res.json({ ok: true });
});

export default router;
