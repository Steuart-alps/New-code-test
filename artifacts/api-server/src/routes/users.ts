import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { usersTable, userRoleEnum } from "@workspace/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { hashPassword } from "../lib/auth";
import { requireAuth, requireClientAdmin, canAccessClient } from "../middleware/requireAuth";

const router = Router();

const CreateUserBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.enum(userRoleEnum as unknown as [string, ...string[]]).default("client_viewer"),
  clientId: z.number().nullable().optional(),
  departmentId: z.number().nullable().optional(),
  active: z.boolean().default(true),
});

const UpdateUserBody = z.object({
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  name: z.string().min(1).optional(),
  role: z.enum(userRoleEnum as unknown as [string, ...string[]]).optional(),
  departmentId: z.number().nullable().optional(),
  active: z.boolean().optional(),
  isMaintenanceManager: z.boolean().optional(),
});

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
        .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
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
        .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
        .from(usersTable)
        .where(inArray(usersTable.clientId, allowed));
    }
  } else {
    rows = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt })
      .from(usersTable)
      .where(eq(usersTable.clientId, user.clientId!));
  }
  
  res.json(rows);
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

  const passwordHash = await hashPassword(body.password);
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
    .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt });

  res.status(201).json(rows[0]);
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
  if (body.email !== undefined) updates.email = body.email;
  if (body.name !== undefined) updates.name = body.name;
  if (body.role !== undefined) updates.role = body.role as typeof userRoleEnum[number];
  if (body.departmentId !== undefined) updates.departmentId = body.departmentId;
  if (body.active !== undefined) updates.active = body.active;
  if (body.isMaintenanceManager !== undefined) updates.isMaintenanceManager = body.isMaintenanceManager;
  if (body.password) updates.passwordHash = await hashPassword(body.password);

  const rows = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active, totpEnabled: usersTable.totpEnabled, isMaintenanceManager: usersTable.isMaintenanceManager, createdAt: usersTable.createdAt, updatedAt: usersTable.updatedAt });

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

  await db.update(usersTable)
    .set({ totpSecret: null, totpEnabled: false, totpRecoveryHash: null, updatedAt: new Date() })
    .where(eq(usersTable.id, id));
  res.json({ ok: true });
});

export default router;
