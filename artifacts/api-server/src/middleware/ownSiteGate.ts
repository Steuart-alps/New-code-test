import type { Request, Response, NextFunction } from "express";
import { getActiveDepartmentId } from "./requireAuth";
import { departmentSiteId } from "../lib/departmentSites";
import { logger } from "../lib/logger";

// One site can't create records for another (Steuart, 4 Nov 2026: "limit to
// user own site for all tracks").
//
// Anyone whose department sits under a site (departments.site_id) works at
// that site only: Staff, Viewers and Managers working in that department.
// Owners, Consultants and every-department Managers have no own site and are
// not limited here. Each route already hides other sites' records and most
// refuse another site's id; this guard makes the rule the same on every track:
//
// - a body siteId naming another site is refused (403), on any new record or
//   edit;
// - a new record (POST) sent with siteId null or blank is saved to the user's
//   own site, so a site's staff can't add records that every site would see.
//   An edit that leaves siteId empty is left alone (older records without a
//   site stay as they are).
//
// Only a top-level JSON siteId is read. Requests from people who aren't
// signed in (contractor sign-in, public links) are not affected.

const MUTATIONS = new Set(["POST", "PUT", "PATCH"]);

// Requests where a blank siteId names a scope (the whole business), not a
// record's site. The route itself refuses that scope to people tied to a site,
// so it is left for the route to answer rather than quietly narrowed.
const BLANK_SITE_IS_SCOPE = new Set(["/staff-roster/reconcile"]);

export const OWN_SITE_ERROR = "You can only add or change records for your own site.";

export async function enforceOwnSite(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  const body = req.body as Record<string, unknown> | undefined;
  if (!user || !MUTATIONS.has(req.method) || !body || typeof body !== "object" || Array.isArray(body)
    || !Object.prototype.hasOwnProperty.call(body, "siteId")) {
    next();
    return;
  }
  const departmentId = getActiveDepartmentId(req);
  if (departmentId === null || departmentId <= 0) {
    next();
    return;
  }

  let ownSiteId: number | null;
  try {
    ownSiteId = await departmentSiteId(departmentId);
  } catch (err) {
    logger.error({ err, departmentId }, "Own-site check failed");
    res.status(500).json({ error: "Could not check your site. Please try again." });
    return;
  }
  if (ownSiteId === null) {
    next();
    return;
  }

  const raw = body.siteId;
  const empty = raw === null || raw === undefined || raw === "" || raw === "none";
  if (empty) {
    if (req.method === "POST" && !BLANK_SITE_IS_SCOPE.has(req.path)) body.siteId = ownSiteId;
    next();
    return;
  }
  if (Number(raw) !== ownSiteId) {
    res.status(403).json({ error: OWN_SITE_ERROR, code: "other_site" });
    return;
  }
  next();
}
