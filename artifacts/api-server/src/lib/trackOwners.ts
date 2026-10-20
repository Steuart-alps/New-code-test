/**
 * Track owners: who receives a track's (module's) in-app reminders.
 *
 * Resolution for (business, module, site):
 *   1. the owner set for that module at that site;
 *   2. else the module-wide owner (site_id NULL);
 *   3. else the business's admins: active client_admin users of the business
 *      plus consultants linked to it (consultant_clients, or users.client_id =
 *      the business, which is how self-signup owners are stored).
 * An assigned owner is skipped (falling through to the next step) when they
 * are no longer active, no longer belong to the business, or cannot see the
 * site because of department scoping (a department under a site covers only
 * that site).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface OwnerCandidate {
  id: number;
  name: string;
  email: string;
  role: string;
  departmentId: number | null;
  allDepartments?: boolean;
  /** A Manager's extra departments (beyond departmentId). */
  extraDepartmentIds?: number[];
  /** Department id -> site, for those of the user's departments that sit under a site. */
  departmentSiteIds?: Record<number, number>;
}

export interface TrackOwnerRow {
  id: number;
  module: string;
  siteId: number | null;
  userId: number;
}

export interface OwnerContext {
  clientId: number;
  owners: TrackOwnerRow[];
  /** Users of the business who may own a track (active, not read-only). */
  eligible: Map<number, OwnerCandidate>;
  /** The business's admins/owners: the fallback recipients. */
  fallback: number[];
  /** Site id -> department id (null = visible to every department). */
  siteDepartments: Map<number, number | null>;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

/**
 * Active users who may own a track in this business: its client_admin,
 * client_manager and client_staff users, and consultants who belong to or are linked to it.
 * Read-only viewers are never owners.
 */
export async function loadEligibleOwners(clientId: number): Promise<OwnerCandidate[]> {
  const result = await db.execute(sql`
    SELECT u.id, u.name, u.email, u.role, u.department_id, u.all_departments,
      ARRAY(SELECT ud.department_id FROM user_departments ud WHERE ud.user_id = u.id) AS extra_department_ids,
      (SELECT json_object_agg(d.id, d.site_id) FROM departments d
        WHERE d.site_id IS NOT NULL
          AND (d.id = u.department_id OR d.id IN (SELECT ud.department_id FROM user_departments ud WHERE ud.user_id = u.id))
      ) AS department_site_ids
    FROM users u
    WHERE u.active = true
      AND (
        (u.client_id = ${clientId} AND u.role IN ('client_admin', 'client_manager', 'client_staff', 'consultant'))
        OR (u.role = 'consultant' AND EXISTS (
          SELECT 1 FROM consultant_clients cc WHERE cc.user_id = u.id AND cc.client_id = ${clientId}
        ))
      )
    ORDER BY u.name, u.id
  `);
  return rowsOf<{ id: number; name: string; email: string; role: string; department_id: number | null; all_departments: boolean | null; extra_department_ids: Array<number | string> | null; department_site_ids: Record<string, number | string> | null }>(result)
    .map((row) => ({
      id: Number(row.id),
      name: row.name,
      email: row.email,
      role: row.role,
      departmentId: row.department_id == null ? null : Number(row.department_id),
      allDepartments: row.all_departments === true,
      extraDepartmentIds: row.role === "client_manager" ? (row.extra_department_ids ?? []).map(Number) : [],
      departmentSiteIds: Object.fromEntries(Object.entries(row.department_site_ids ?? {})
        .map(([departmentId, siteId]) => [Number(departmentId), Number(siteId)])),
    }));
}

/**
 * Whether a user can see a site's records (department scoping, as in
 * getActiveDepartmentId). Each of the user's departments covers the site when
 * the site is shared or that department's, and the department does not sit
 * under another site.
 */
export function candidateCanSeeSite(
  candidate: Pick<OwnerCandidate, "role" | "departmentId" | "allDepartments" | "extraDepartmentIds" | "departmentSiteIds">,
  siteDepartmentId: number | null | undefined,
  siteId: number,
): boolean {
  if (candidate.role === "client_admin" || candidate.role === "consultant") return true;
  if (candidate.role === "client_manager" && candidate.allDepartments === true) return true;
  const covers = (departmentId: number | null) => {
    if (siteDepartmentId != null && departmentId !== siteDepartmentId) return false;
    const departmentSite = departmentId == null ? undefined : candidate.departmentSiteIds?.[departmentId];
    return departmentSite == null || departmentSite === siteId;
  };
  return covers(candidate.departmentId)
    || (candidate.role === "client_manager" && (candidate.extraDepartmentIds ?? []).some(covers));
}

export async function loadOwnerContext(clientId: number): Promise<OwnerContext> {
  const [candidates, ownerResult, siteResult] = await Promise.all([
    loadEligibleOwners(clientId),
    db.execute(sql`
      SELECT id, module, site_id, user_id FROM track_owners
      WHERE client_id = ${clientId}
    `),
    db.execute(sql`SELECT id, department_id FROM sites WHERE client_id = ${clientId}`),
  ]);
  const eligible = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const owners = rowsOf<{ id: number; module: string; site_id: number | null; user_id: number }>(ownerResult)
    .map((row) => ({
      id: Number(row.id),
      module: row.module,
      siteId: row.site_id == null ? null : Number(row.site_id),
      userId: Number(row.user_id),
    }));
  const siteDepartments = new Map(
    rowsOf<{ id: number; department_id: number | null }>(siteResult)
      .map((row) => [Number(row.id), row.department_id == null ? null : Number(row.department_id)] as const),
  );
  const fallback = candidates
    .filter((candidate) => candidate.role === "client_admin" || candidate.role === "consultant")
    .map((candidate) => candidate.id);
  return { clientId, owners, eligible, fallback, siteDepartments };
}

/** The user ids that should receive a module's reminder for a site (null = whole business). */
export function resolveOwnersFromContext(ctx: OwnerContext, module: string, siteId: number | null): number[] {
  const usable = (row: TrackOwnerRow | undefined): boolean => {
    if (!row) return false;
    const candidate = ctx.eligible.get(row.userId);
    if (!candidate) return false;
    return siteId == null || candidateCanSeeSite(candidate, ctx.siteDepartments.get(siteId), siteId);
  };
  if (siteId != null) {
    const siteOwner = ctx.owners.find((row) => row.module === module && row.siteId === siteId);
    if (usable(siteOwner)) return [siteOwner!.userId];
  }
  const moduleOwner = ctx.owners.find((row) => row.module === module && row.siteId === null);
  if (usable(moduleOwner)) return [moduleOwner!.userId];
  return [...ctx.fallback];
}

/** Whether an owner has been set for the module at this site (or for all sites). */
export function hasExplicitOwner(ctx: OwnerContext, module: string, siteId: number | null): boolean {
  return ctx.owners.some((row) => row.module === module && (row.siteId === null || row.siteId === siteId));
}

export async function resolveTrackOwnerIds(clientId: number, module: string, siteId: number | null): Promise<number[]> {
  return resolveOwnersFromContext(await loadOwnerContext(clientId), module, siteId);
}
