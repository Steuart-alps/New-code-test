import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { usersTable, userRoleEnum, departmentsTable, userDepartmentsTable, staffMembersTable, passwordResetTokensTable, auditEventsTable, incidentRiddorEventsTable, feedbackReportReviewsTable } from "@workspace/db/schema";
import { eq, and, inArray, isNull, desc, gt, sql } from "drizzle-orm";
import { hashPassword, getUserWithClientByEmail } from "../lib/auth";
import { requireAuth, requireClientAdmin, requireRole, requireUserManager, canAccessClient } from "../middleware/requireAuth";
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
  departmentId: z.number().int().positive().nullable().optional(),
  allDepartments: z.boolean().optional(),
  departmentIds: z.array(z.number().int().positive()).max(200).optional(),
  staffRosterId: z.number().int().positive().nullable().optional(),
  isMaintenanceManager: z.boolean().optional(),
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
  departmentId: z.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
  isMaintenanceManager: z.boolean().optional(),
  isDepartmentManager: z.boolean().optional(),
  allDepartments: z.boolean().optional(),
  departmentIds: z.array(z.number().int().positive()).max(200).optional(),
  staffRosterId: z.number().int().positive().nullable().optional(),
});

/** The roles a Manager may give and look after. */
const MANAGED_ROLES = new Set(["client_staff", "client_viewer"]);

type ManagerActor = { id: number; role: string; clientId: number | null; departmentId: number | null; allDepartments?: boolean | null; departmentIds: number[] };

function isManager(actor: { role: string }): boolean {
  return actor.role === "client_manager";
}

/** The signed-in user, with every department they cover when they're a Manager. */
function actorOf(req: Request): ManagerActor {
  const user = req.currentUser!;
  return { ...user, departmentIds: req.departmentIds ?? (user.departmentId != null ? [user.departmentId] : []) };
}

/** Whether a department id is one this Manager covers (null = no department). */
async function managerCoversDepartment(actor: ManagerActor, departmentId: number | null | undefined): Promise<boolean> {
  if (departmentId == null) return actor.allDepartments === true;
  if (actor.allDepartments !== true) return actor.departmentIds.includes(departmentId);
  return (await departmentsInClient(actor.clientId, [departmentId]));
}

/** Whether every id is a department of this business. */
async function departmentsInClient(clientId: number | null, ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  const rows = await db.select({ id: departmentsTable.id }).from(departmentsTable)
    .where(and(inArray(departmentsTable.id, ids), eq(departmentsTable.clientId, clientId ?? -1)));
  return rows.length === new Set(ids).size;
}

/** Whether a staff roster entry belongs to this business. */
async function rosterEntryInClient(clientId: number | null, staffRosterId: number): Promise<boolean> {
  const [row] = await db.select({ id: staffMembersTable.id }).from(staffMembersTable)
    .where(and(eq(staffMembersTable.id, staffRosterId), eq(staffMembersTable.clientId, clientId ?? -1)));
  return !!row;
}

/** Adds each user's departments (main first, then a Manager's extra ones). */
async function withDepartmentIds<T extends { id: number; departmentId: number | null }>(rows: T[]): Promise<Array<T & { departmentIds: number[] }>> {
  const extras = rows.length
    ? await db.select().from(userDepartmentsTable).where(inArray(userDepartmentsTable.userId, rows.map((row) => row.id)))
    : [];
  return rows.map((row) => {
    const ids = row.departmentId != null ? [row.departmentId] : [];
    for (const extra of extras) if (extra.userId === row.id && !ids.includes(extra.departmentId)) ids.push(extra.departmentId);
    return { ...row, departmentIds: ids };
  });
}

/** Replaces a user's extra departments (everything after the main one). */
async function setExtraDepartments(userId: number, extraIds: number[]) {
  await db.transaction(async (tx) => {
    await tx.delete(userDepartmentsTable).where(eq(userDepartmentsTable.userId, userId));
    if (extraIds.length) {
      await tx.insert(userDepartmentsTable).values([...new Set(extraIds)].map((departmentId) => ({ userId, departmentId })));
    }
  });
}

/**
 * Managers look after the Staff and Viewers in their own business and
 * departments. Anyone else answers like a missing user, so a Manager can't
 * learn who else has an account.
 */
function managerCanActOn(actor: ManagerActor, target: { role: string; clientId: number | null; departmentId: number | null }): boolean {
  if (target.clientId == null || target.clientId !== actor.clientId) return false;
  if (!MANAGED_ROLES.has(target.role)) return false;
  return actor.allDepartments === true || (target.departmentId != null && actor.departmentIds.includes(target.departmentId));
}

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

router.get("/users", requireAuth, requireUserManager, async (req, res) => {
  const user = actorOf(req);
  
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
        .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, allDepartments: usersTable.allDepartments, staffRosterId: usersTable.staffRosterId, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
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
        .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, allDepartments: usersTable.allDepartments, staffRosterId: usersTable.staffRosterId, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
        .from(usersTable)
        .where(inArray(usersTable.clientId, allowed));
    }
  } else {
    rows = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, allDepartments: usersTable.allDepartments, staffRosterId: usersTable.staffRosterId, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
      .from(usersTable)
      .where(eq(usersTable.clientId, user.clientId!));
    if (isManager(user)) rows = rows.filter((row) => row.id === user.id || managerCanActOn(user, row));
  }

  const invitations = await invitationsFor(rows.map((row) => row.id));
  res.json((await withDepartmentIds(rows)).map((row) => ({ ...row, invitation: invitations.get(row.id) ?? null })));
});

router.post("/users", requireAuth, requireUserManager, async (req, res) => {
  const actor = actorOf(req);
  const body = CreateUserBody.parse(req.body);

  if (isManager(actor)) {
    if (!MANAGED_ROLES.has(body.role)) {
      res.status(403).json({ error: "Managers can add Staff and Viewers only" });
      return;
    }
    if (body.allDepartments || body.isMaintenanceManager || (body.departmentIds?.length ?? 0) > 1) {
      res.status(403).json({ error: "Only an Owner can give these extra rights" });
      return;
    }
    if (body.departmentIds?.length === 1) body.departmentId = body.departmentIds[0];
    if (body.departmentId === undefined && actor.allDepartments !== true) body.departmentId = actor.departmentId;
    if (!(await managerCoversDepartment(actor, body.departmentId))) {
      res.status(403).json({ error: "Managers can add people to their own departments only" });
      return;
    }
  }

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

  // A Manager may cover several departments: the first is their main one.
  const departmentIds = body.departmentIds ?? (body.departmentId != null ? [body.departmentId] : []);
  if (departmentIds.length > 1 && body.role !== "client_manager") {
    res.status(400).json({ error: "Only Managers can have more than one department" });
    return;
  }
  if (body.departmentIds) body.departmentId = departmentIds[0] ?? null;
  if (!(await departmentsInClient(body.clientId ?? null, departmentIds))) {
    res.status(400).json({ error: "Department not found" });
    return;
  }
  // A Viewer is linked to their staff roster entry; with none picked, the
  // entry with the same email address is used when there is one.
  if (body.role === "client_viewer" && body.staffRosterId === undefined) {
    const matched = await db.execute(sql`
      SELECT id FROM staff_roster
      WHERE client_id = ${body.clientId ?? -1} AND active = true AND lower(email) = ${body.email.trim().toLowerCase()}
      ORDER BY id LIMIT 1
    `);
    const match = (matched.rows ?? [])[0] as { id: number } | undefined;
    if (match) body.staffRosterId = Number(match.id);
  }
  if (body.staffRosterId != null) {
    if (body.role !== "client_viewer") {
      res.status(400).json({ error: "Only Viewers are linked to a staff roster entry" });
      return;
    }
    if (!(await rosterEntryInClient(body.clientId ?? null, body.staffRosterId))) {
      res.status(400).json({ error: "Staff member not found on the roster" });
      return;
    }
  }

  // Sign-in matches email case-insensitively and registration stores it in
  // lower case; do the same here so an existing address is a clear 409.
  const email = body.email.trim().toLowerCase();

  // When no password is supplied, the admin is inviting the user: create the
  // account with an unusable random password and email them a link to set
  // their own via the existing reset-password token machinery.
  const invite = !body.password;

  // One account per address (sign-in matches case-insensitively). Retrying a
  // failed invitation uses resend-invite on the existing account instead.
  const existing = await getUserWithClientByEmail(email);
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
  let rows;
  try {
    rows = await db
      .insert(usersTable)
      .values({
        email,
        name: body.name,
        role: body.role as typeof userRoleEnum[number],
        clientId: body.clientId ?? null,
        departmentId: body.departmentId ?? null,
        allDepartments: body.role === "client_manager" && body.allDepartments === true,
        isMaintenanceManager: body.isMaintenanceManager === true,
        staffRosterId: body.role === "client_viewer" ? body.staffRosterId ?? null : null,
        active: body.active,
        passwordHash,
      })
      .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, allDepartments: usersTable.allDepartments, staffRosterId: usersTable.staffRosterId, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt });
  } catch (error: any) {
    // A concurrent create of the same address.
    if ((error?.code ?? error?.cause?.code) === "23505") {
      res.status(409).json({ error: "A user with this email already exists" });
      return;
    }
    throw error;
  }

  if (body.role === "client_manager" && body.allDepartments !== true && departmentIds.length > 1) {
    await setExtraDepartments(rows[0].id, departmentIds.slice(1));
  }

  // The account stands either way; when the invitation can't be delivered the
  // admin is told and can resend it from User Management.
  const inviteEmail = invite
    ? (await sendInviteEmail(rows[0], req.log) ? "sent" : "failed")
    : null;

  const [created] = await withDepartmentIds(rows);
  res.status(201).json({ ...created, inviteEmail });
});

/**
 * The staff account a setup-link action targets, after the tenant and role
 * checks shared by resend-invite and revoke-invite. Sends the error response
 * and returns null when the caller may not act on it.
 */
async function setupLinkTarget(req: Request, res: Response, verb: string) {
  const actor = actorOf(req);
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
  if (isManager(actor) && !managerCanActOn(actor, target)) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (target.role !== "client_staff") {
    res.status(400).json({ error: `Password setup links can only be ${verb} for staff accounts` });
    return null;
  }
  return target;
}

router.post("/users/:id/resend-invite", requireAuth, requireUserManager, async (req, res) => {
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
router.post("/users/:id/revoke-invite", requireAuth, requireUserManager, async (req, res) => {
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

// A Manager with several departments picks the one they're working in; it is
// kept in their session (see loadUser) and scopes every page they open.
router.put("/users/me/active-department", requireAuth, requireRole("client_manager"), async (req, res) => {
  const parsed = z.object({ departmentId: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "departmentId is required" });
    return;
  }
  const ids = req.departmentIds ?? [];
  if (!ids.includes(parsed.data.departmentId)) {
    res.status(404).json({ error: "Department not found" });
    return;
  }
  req.session.activeDepartmentId = parsed.data.departmentId;
  res.json({ departmentId: parsed.data.departmentId, departmentIds: ids });
});

router.put("/users/:id", requireAuth, requireUserManager, async (req, res) => {
  const actor = actorOf(req);
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

  if (isManager(actor)) {
    if (target.id === actor.id) {
      // A Manager keeps their own name and sign-in details up to date; their
      // role and departments are set by an Owner.
      // (The edit form sends back the department they're working in.)
      const ownDepartment = body.departmentId === undefined || body.departmentId === target.departmentId
        || (body.departmentId != null && actor.departmentIds.includes(body.departmentId));
      if ((body.role !== undefined && body.role !== target.role)
        || !ownDepartment
        || (body.active !== undefined && body.active !== target.active)
        || body.isMaintenanceManager !== undefined || body.isDepartmentManager !== undefined
        || body.allDepartments !== undefined || body.departmentIds !== undefined || body.staffRosterId !== undefined) {
        res.status(403).json({ error: "Only an Owner can change a Manager's role or departments" });
        return;
      }
      delete body.departmentId;
    } else {
      if (!managerCanActOn(actor, target)) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      if (body.role !== undefined && !MANAGED_ROLES.has(body.role)) {
        res.status(403).json({ error: "Managers can give the Staff or Viewer role only" });
        return;
      }
      if ((body.departmentIds?.length ?? 0) > 1) {
        res.status(403).json({ error: "Only an Owner can give someone several departments" });
        return;
      }
      if (body.departmentIds?.length === 1) body.departmentId = body.departmentIds[0];
      if (body.departmentIds?.length === 0) body.departmentId = null;
      delete body.departmentIds;
      if (body.departmentId !== undefined && !(await managerCoversDepartment(actor, body.departmentId))) {
        res.status(403).json({ error: "Managers can move people within their own departments only" });
        return;
      }
      if (body.isMaintenanceManager !== undefined || body.isDepartmentManager !== undefined || body.allDepartments !== undefined) {
        res.status(403).json({ error: "Only an Owner can change these switches" });
        return;
      }
    }
  }

  const finalRole = body.role ?? target.role;
  if (body.departmentIds !== undefined) {
    if (body.departmentIds.length > 1 && finalRole !== "client_manager") {
      res.status(400).json({ error: "Only Managers can have more than one department" });
      return;
    }
    if (!(await departmentsInClient(target.clientId, body.departmentIds))) {
      res.status(400).json({ error: "Department not found" });
      return;
    }
    body.departmentId = body.departmentIds[0] ?? null;
  } else if (body.departmentId != null && !(await departmentsInClient(target.clientId, [body.departmentId]))) {
    res.status(400).json({ error: "Department not found" });
    return;
  }
  if (body.staffRosterId != null) {
    if (finalRole !== "client_viewer") {
      res.status(400).json({ error: "Only Viewers are linked to a staff roster entry" });
      return;
    }
    if (!(await rosterEntryInClient(target.clientId, body.staffRosterId))) {
      res.status(400).json({ error: "Staff member not found on the roster" });
      return;
    }
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
  if (body.allDepartments !== undefined) {
    if (body.allDepartments && (body.role ?? target.role) !== "client_manager") {
      res.status(400).json({ error: "Only Managers can be given every department" });
      return;
    }
    updates.allDepartments = body.allDepartments;
  }
  if (body.role && body.role !== "client_manager") updates.allDepartments = false;
  if (body.staffRosterId !== undefined) updates.staffRosterId = body.staffRosterId;
  if (finalRole !== "client_viewer") updates.staffRosterId = null;
  if (body.password) updates.passwordHash = await hashPassword(body.password);

  const rows = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, allDepartments: usersTable.allDepartments, staffRosterId: usersTable.staffRosterId, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt });

  // Extra departments are for Managers who don't already cover every one.
  const finalAll = updates.allDepartments ?? target.allDepartments;
  if (finalRole !== "client_manager" || finalAll) await setExtraDepartments(id, []);
  else if (body.departmentIds !== undefined) await setExtraDepartments(id, body.departmentIds.slice(1));

  // A changed password signs the user out everywhere except this session.
  if (updates.passwordHash) {
    await revokeUserSessions(id, { exceptSessionId: req.sessionID });
  }

  const [updated] = await withDepartmentIds(rows);
  res.json(updated);
});

router.delete("/users/:id", requireAuth, requireUserManager, async (req, res) => {
  const actor = actorOf(req);
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
  if (isManager(actor) && !managerCanActOn(actor, target)) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Audit trails are append-only, so a user one names as actor can't be
  // deleted (ON DELETE SET NULL would rewrite those rows). Deactivate them
  // instead, which also ends their sessions.
  const authored = await Promise.all([
    db.select({ id: auditEventsTable.id }).from(auditEventsTable).where(eq(auditEventsTable.actorId, id)).limit(1),
    db.select({ id: incidentRiddorEventsTable.id }).from(incidentRiddorEventsTable).where(eq(incidentRiddorEventsTable.actorId, id)).limit(1),
    db.select({ id: feedbackReportReviewsTable.id }).from(feedbackReportReviewsTable).where(eq(feedbackReportReviewsTable.actorId, id)).limit(1),
  ]);
  if (authored.some((rows) => rows.length > 0)) {
    const rows = await db
      .update(usersTable)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(usersTable.id, id))
      .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, isDepartmentManager: usersTable.isDepartmentManager, allDepartments: usersTable.allDepartments, staffRosterId: usersTable.staffRosterId, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt });
    res.json({ ...rows[0], deactivated: true });
    return;
  }

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
