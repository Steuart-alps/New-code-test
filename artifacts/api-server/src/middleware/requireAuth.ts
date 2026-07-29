import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { consultantClientsTable } from "@workspace/db/schema";
import { getUserById } from "../lib/auth";
import type { SafeUser, UserRole } from "@workspace/db/schema";

declare global {
  namespace Express {
    interface Request {
      currentUser?: SafeUser;
      // Client accounts the current user is allowed to act on. Populated for
      // consultant-role users from consultant_clients plus their own clientId.
      allowedClientIds?: Set<number>;
    }
  }
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  if (req.session.userId) {
    const user = await getUserById(req.session.userId);
    if (user && user.active) {
      req.currentUser = user;
      if (user.role === "consultant") {
        const allowed = new Set<number>();
        if (user.clientId != null) allowed.add(user.clientId);
        const memberships = await db
          .select({ clientId: consultantClientsTable.clientId })
          .from(consultantClientsTable)
          .where(eq(consultantClientsTable.userId, user.id));
        for (const m of memberships) allowed.add(m.clientId);
        req.allowedClientIds = allowed;
      }
    }
  }
  next();
}

/**
 * Global guard: if the request supplies a clientId (query or body), the caller
 * must actually be allowed to act on that client. Consultants are limited to
 * clients they are linked to; everyone else to their own client. Mounted once
 * after loadUser so every route is covered, including direct req.body.clientId
 * reads in create paths.
 */
export function enforceClientAccess(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  if (!user) {
    next();
    return;
  }
  const raw = req.query.clientId ?? req.body?.clientId;
  if (raw === undefined || raw === null || raw === "") {
    next();
    return;
  }
  const clientId = Number(raw);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    res.status(400).json({ error: "Invalid clientId" });
    return;
  }
  if (!canAccessClient(req, clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

/** Whether the current user may act on the given client account. */
export function canAccessClient(req: Request, clientId: number | null | undefined): boolean {
  const user = req.currentUser;
  if (!user || clientId == null) return false;
  if (user.clientId === clientId) return true;
  if (user.role === "consultant") {
    return req.allowedClientIds?.has(clientId) ?? false;
  }
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.currentUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.currentUser.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

export function requireConsultant(req: Request, res: Response, next: NextFunction) {
  return requireRole("consultant")(req, res, next);
}

export function requireClientAdmin(req: Request, res: Response, next: NextFunction) {
  return requireRole("consultant", "client_admin")(req, res, next);
}

/**
 * Returns the department ID that should restrict what data this user can see,
 * or null if the user is unrestricted (admin / consultant / unassigned staff).
 *
 * Only client_staff and client_viewer are subject to department scoping.
 * A staff/viewer with no departmentId (null) is also unrestricted — they see
 * everything, matching the pre-departments behaviour.
 */
export function getActiveDepartmentId(req: Request): number | null {
  const user = req.currentUser;
  if (!user) return null;
  if (user.role === "client_admin" || user.role === "consultant") return null;
  return (user as any).departmentId ?? null;
}

export function getClientId(req: Request): number | null {
  if (!req.currentUser) return null;
  if (req.currentUser.role === "consultant") {
    const raw = req.query.clientId ?? req.body?.clientId;
    if (raw !== undefined && raw !== null && raw !== "") {
      const clientId = Number(raw);
      // Defense in depth: enforceClientAccess already rejects unauthorized
      // clientIds, but never honor one here that isn't explicitly linked.
      return canAccessClient(req, clientId) ? clientId : null;
    }
    // Self-service sign-ups are created with role "consultant" but linked to a
    // single auto-provisioned business. Fall back to that linked business when
    // no explicit clientId is supplied so the user sees their own data.
    return req.currentUser.clientId ?? null;
  }
  return req.currentUser.clientId ?? null;
}
