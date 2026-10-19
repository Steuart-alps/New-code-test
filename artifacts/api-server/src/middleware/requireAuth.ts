import type { Request, Response, NextFunction } from "express";
import { eq, sql } from "drizzle-orm";
import { auditContext, db } from "@workspace/db";
import { clientsTable, consultantClientsTable, userDepartmentsTable } from "@workspace/db/schema";
import { getUserById } from "../lib/auth";
import { isTwoFactorRequired } from "../lib/twoFactorPolicy";
import { storedCredentialCandidates } from "../lib/sessionRevocation";
import type { SafeUser, UserRole } from "@workspace/db/schema";

declare global {
  namespace Express {
    interface Request {
      currentUser?: SafeUser;
      // Client accounts the current user is allowed to act on. Populated for
      // consultant-role users from consultant_clients plus their own clientId;
      // a consultant who is also a platform operator gets every business.
      allowedClientIds?: Set<number>;
      // Every department a Manager covers, main one first. Set for Managers
      // without every-department access; currentUser.departmentId is then
      // the one they're working in.
      departmentIds?: number[];
    }
  }
}

async function loadConsultantClients(req: Request, userId: number) {
  const user = req.currentUser;
  if (!user || user.role !== "consultant") return;
  const allowed = new Set<number>();
  if (user.clientId != null) allowed.add(user.clientId);
  if (isPlatformOperator(user)) {
    // ALPS's own consultant sign-in looks after every business on the service.
    const clients = await db.select({ id: clientsTable.id }).from(clientsTable);
    for (const client of clients) allowed.add(client.id);
    req.allowedClientIds = allowed;
    return;
  }
  const memberships = await db
    .select({ clientId: consultantClientsTable.clientId })
    .from(consultantClientsTable)
    .where(eq(consultantClientsTable.userId, userId));
  for (const m of memberships) allowed.add(m.clientId);
  req.allowedClientIds = allowed;
}

/** A Manager's main department and any extra ones, main first. */
export async function managerDepartmentIds(user: Pick<SafeUser, "id" | "departmentId">): Promise<number[]> {
  const extras = await db
    .select({ departmentId: userDepartmentsTable.departmentId })
    .from(userDepartmentsTable)
    .where(eq(userDepartmentsTable.userId, user.id));
  const ids = user.departmentId != null ? [user.departmentId] : [];
  for (const row of extras) if (!ids.includes(row.departmentId)) ids.push(row.departmentId);
  return ids;
}

/**
 * A Manager with several departments works in one at a time, chosen with
 * PUT /users/me/active-department and kept in their session. Department
 * scoping everywhere reads currentUser.departmentId, so it is set to that
 * department (their main one until they switch, and always on the phone app).
 */
async function loadManagerDepartments(req: Request) {
  const user = req.currentUser;
  if (!user || user.role !== "client_manager" || user.allDepartments) return;
  const ids = await managerDepartmentIds(user);
  req.departmentIds = ids;
  const chosen = req.session?.activeDepartmentId;
  const active = chosen != null && ids.includes(chosen) ? chosen : ids[0] ?? null;
  if (active !== user.departmentId) req.currentUser = { ...user, departmentId: active };
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  let userId: number | undefined;

  // 1. Web session auth
  if (req.session.userId) {
    userId = req.session.userId;
  }

  // 2. Bearer token auth (mobile app)
  if (!userId) {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const [hashed, legacy = hashed] = storedCredentialCandidates(auth.slice(7));
      try {
        // Tokens are stored hashed; a legacy plaintext row (written by an
        // older instance mid-deploy) still matches until start-up hashes it.
        const result = await db.execute(sql`
          SELECT user_id FROM mobile_sessions
          WHERE token IN (${hashed}, ${legacy}) AND expires_at > now()
          LIMIT 1
        `);
        const row = (result as any).rows?.[0] as { user_id: number } | undefined;
        if (row) userId = row.user_id;
      } catch {
        // mobile_sessions may not exist yet (pre-migration) — skip silently
      }
    }
  }

  if (userId) {
    const user = await getUserById(userId);
    if (user && user.active) {
      req.currentUser = user;
      await loadConsultantClients(req, userId);
      await loadManagerDepartments(req);
    }
  }

  const context = { actorId: req.currentUser?.id ?? null, active: true };
  _res.once("finish", () => { context.active = false; });
  _res.once("close", () => { context.active = false; });
  auditContext.run(context, next);
}

/**
 * The clientId a request names, read the same way by enforceClientAccess and
 * getClientId. It may arrive in the query string, the JSON body or both (the
 * web client adds the active business to every URL); every supplied value
 * must agree, so a route that reads req.body.clientId directly can never act
 * on a business other than the one the guard checked. Returns undefined when
 * none is supplied, "conflict" when values differ, otherwise the number (NaN
 * when malformed).
 */
export function requestedClientId(req: Request): number | "conflict" | undefined {
  const raw: unknown[] = [];
  const fromQuery = req.query.clientId;
  if (Array.isArray(fromQuery)) raw.push(...fromQuery);
  else raw.push(fromQuery);
  const body = req.body;
  if (body && typeof body === "object" && !Array.isArray(body)) raw.push((body as Record<string, unknown>).clientId);
  const values = raw
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => (typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN));
  if (values.length === 0) return undefined;
  const first = values[0];
  if (values.some((value) => !Object.is(value, first))) return "conflict";
  return first;
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
  const requested = requestedClientId(req);
  if (requested === undefined) {
    next();
    return;
  }
  if (requested === "conflict") {
    res.status(400).json({ error: "The clientId in the URL and the request body do not match" });
    return;
  }
  const clientId = requested;
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

/**
 * Accounts must have an enrolled second factor unless every client they
 * belong to has turned the requirement off (see lib/twoFactorPolicy).
 * Staff-roster people are not users and never reach this guard. The setup
 * endpoints and logout remain available so an unenrolled account can finish
 * enrollment or leave the session.
 */
export async function enforceTwoFactorEnrollment(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  if (process.env.NODE_ENV === "test" && process.env.ENFORCE_MANDATORY_2FA !== "1") {
    next();
    return;
  }
  if (!user) {
    next();
    return;
  }
  if (user.totpEnabled || !(await isTwoFactorRequired(user))) {
    next();
    return;
  }
  const path = req.path.replace(/^\/api/, "");
  const allowed = path === "/auth/login"
    || path === "/auth/me"
    || path === "/auth/logout"
    || path === "/auth/2fa/setup"
    || path === "/auth/2fa/enable"
    || path === "/auth/passkeys/registration/options"
    || path === "/auth/passkeys/registration/verify"
    || path === "/auth/csrf-token";
  if (allowed) {
    next();
    return;
  }
  res.status(403).json({
    error: "Two-factor authentication setup is required before using ComplyTrack",
    requires2faSetup: true,
  });
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

/**
 * Platform operators run the ComplyTrack service itself (Stripe catalogue
 * repair, ALPS discount codes, unrestricted business creation, and, when
 * signed in as a consultant, access to every business). The "consultant" role
 * cannot be used for this because outside consultancies have it too (and
 * older self-signup owners still do), so operators are named explicitly by
 * sign-in email in the
 * PLATFORM_ADMIN_EMAILS allowlist (comma-separated, case-insensitive). Unset
 * or empty means nobody is a platform operator.
 */
export function isPlatformOperator(user: Pick<SafeUser, "email"> | null | undefined): boolean {
  if (!user?.email) return false;
  const allowlist = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  return allowlist.includes(user.email.trim().toLowerCase());
}

export function requirePlatformOperator(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!isPlatformOperator(req.currentUser)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

export function requireClientAdmin(req: Request, res: Response, next: NextFunction) {
  return requireRole("consultant", "client_admin")(req, res, next);
}

/**
 * Blocks read-only users (client_viewer) from mutation routes.
 * Mount AFTER requireAuth on POST/PUT/PATCH/DELETE handlers.
 */
export function denyViewers(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.currentUser.role === "client_viewer") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

/**
 * Returns the department ID that should restrict what data this user can see,
 * or null if the user is unrestricted (admin / consultant).
 *
 * client_staff, client_viewer and client_manager are subject to department
 * scoping, unless the Manager has been given every department.
 * Unassigned staff/viewers receive a non-matching sentinel. Existing route
 * filters consequently expose only explicitly unassigned/site-neutral records,
 * never every department's records.
 */
export function getActiveDepartmentId(req: Request): number | null {
  const user = req.currentUser;
  if (!user) return null;
  if (user.role === "client_admin" || user.role === "consultant") return null;
  if (user.role === "client_manager" && user.allDepartments === true) return null;
  return (user as any).departmentId ?? -1;
}

/**
 * Managers, and Staff with the older "Department manager" switch, lead their
 * department: department summaries, CSV imports, inspection exports, RIDDOR
 * health data and department tasks.
 */
export function isDepartmentLead(user: Pick<SafeUser, "role" | "isDepartmentManager"> | null | undefined): boolean {
  if (!user) return false;
  return user.role === "client_manager" || (user.role === "client_staff" && user.isDepartmentManager === true);
}

/** Owners and consultants manage every user; Managers manage the Staff and Viewers in their departments. */
export function requireUserManager(req: Request, res: Response, next: NextFunction) {
  return requireRole("consultant", "client_admin", "client_manager")(req, res, next);
}

export function getClientId(req: Request): number | null {
  if (!req.currentUser) return null;
  if (req.currentUser.role === "consultant") {
    const clientId = requestedClientId(req);
    if (clientId === "conflict") return null;
    if (clientId !== undefined) {
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
