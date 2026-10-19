import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { getActiveDepartmentId, getClientId } from "../middleware/requireAuth";

// BikeTrack department scoping. Department-scoped staff and viewers see and
// change only bikes at their department's sites, plus site-neutral ones, as on
// the other tracks. A hire belongs to its own site, else its bike's; checks and
// services follow their bike. Writes are checked by bikeDepartmentWrites, ahead
// of every handler, so the web and phone routes share the rule.

function departmentSites(clientId: number, departmentId: number) {
  return sql`SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${departmentId})`;
}

/** SQL condition (with leading AND) limiting `siteColumn` to the caller's department, or nothing. */
export function departmentScope(req: Request, clientId: number, siteColumn: SQL) {
  const departmentId = getActiveDepartmentId(req);
  return departmentId === null ? sql`` : sql`AND (${siteColumn} IS NULL OR ${siteColumn} IN (${departmentSites(clientId, departmentId)}))`;
}

async function siteAllowed(siteId: unknown, clientId: number, departmentId: number) {
  // Null is a site-neutral record; non-numbers are rejected by the body schemas.
  if (typeof siteId !== "number") return true;
  const result = await db.execute(sql`SELECT 1 FROM sites WHERE id = ${siteId} AND client_id = ${clientId}
    AND (department_id IS NULL OR department_id = ${departmentId})`);
  return (result.rows ?? []).length > 0;
}

// The stored site of the record a write path names, or undefined when the
// record does not exist (the handler then answers 404).
async function recordSite(kind: string, id: number, clientId: number): Promise<number | null | undefined> {
  const query = kind === "bikes"
    ? sql`SELECT site_id FROM bikes WHERE id = ${id} AND client_id = ${clientId}`
    : kind === "hires"
      ? sql`SELECT COALESCE(h.site_id, b.site_id) AS site_id FROM bike_hire_records h
          JOIN bikes b ON b.id = h.bike_id WHERE h.id = ${id} AND h.client_id = ${clientId}`
      : sql`SELECT b.site_id FROM bike_services s JOIN bikes b ON b.id = s.bike_id
          WHERE s.id = ${id} AND s.client_id = ${clientId}`;
  const [row] = ((await db.execute(query)).rows ?? []) as Array<{ site_id: number | null }>;
  return row ? row.site_id : undefined;
}

const RECORD_WRITE_PATH = /^\/(bikes|hires|services)(?:\/(\d+)(?:\/return)?)?\/?$/i;

/**
 * Router-level guard for BikeTrack writes: another department's bike, hire or
 * service answers 403, as does a write naming another department's bike or site.
 */
export async function bikeDepartmentWrites(req: Request, res: Response, next: NextFunction) {
  const clientId = getClientId(req);
  const departmentId = getActiveDepartmentId(req);
  const match = RECORD_WRITE_PATH.exec(req.path);
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !clientId || departmentId === null || !match) return next();
  try {
    const kind = match[1].toLowerCase();
    if (match[2]) {
      const site = await recordSite(kind, Number(match[2]), clientId);
      if (site !== undefined && !(await siteAllowed(site, clientId, departmentId))) {
        return void res.status(403).json({ error: "Forbidden" });
      }
    }
    const bikeId = req.body?.bikeId;
    if (!match[2] && kind !== "bikes" && typeof bikeId === "number") {
      const site = await recordSite("bikes", bikeId, clientId);
      if (site !== undefined && !(await siteAllowed(site, clientId, departmentId))) {
        return void res.status(403).json({ error: "Forbidden" });
      }
    }
    if (!(await siteAllowed(req.body?.siteId, clientId, departmentId))) {
      return void res.status(403).json({ error: "Site not accessible" });
    }
    next();
  } catch (err) {
    next(err);
  }
}
