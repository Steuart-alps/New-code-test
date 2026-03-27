import type { Request, Response, NextFunction } from "express";
import { getUserById } from "../lib/auth";
import type { SafeUser, UserRole } from "@workspace/db/schema";

declare global {
  namespace Express {
    interface Request {
      currentUser?: SafeUser;
    }
  }
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  if (req.session.userId) {
    const user = await getUserById(req.session.userId);
    if (user && user.active) {
      req.currentUser = user;
    }
  }
  next();
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

export function getClientId(req: Request): number | null {
  if (!req.currentUser) return null;
  if (req.currentUser.role === "consultant") {
    const clientId = req.query.clientId ?? req.body?.clientId;
    return clientId ? Number(clientId) : null;
  }
  return req.currentUser.clientId ?? null;
}
