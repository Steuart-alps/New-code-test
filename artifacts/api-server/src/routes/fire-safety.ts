import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { fireSafetyChecksTable, sitesTable, appSettingsTable, trackControlProfilesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, denyViewers, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { appendAuditEvent } from "../lib/audit";
import { resolveStaffPerformer, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import { FIRE_CHECK_TYPES, FIRE_FREQUENCY_DAYS, getFireSiteStatuses, worstFireStatusByType } from "../lib/checkReminders";

const router = Router();

const CHECK_TYPES = FIRE_CHECK_TYPES;

// Default check frequencies, in days
const FREQUENCY_DAYS = FIRE_FREQUENCY_DAYS;

const FIRE_PROFILE_MODULE = "fire";
const fireProfileSchema = z.object({
  riskAssessmentReference: z.string().trim().max(2000).nullable().optional(),
  riskAssessmentDate: z.string().date().nullable().optional(),
  nextReviewDate: z.string().date().nullable().optional(),
  responsiblePerson: z.string().trim().max(500).nullable().optional(),
  ukNation: z.enum(["england", "scotland", "wales", "northern_ireland"]).nullable().optional(),
  evacuationPeepArrangements: z.string().trim().max(10000).nullable().optional(),
  maintenanceEvidenceReference: z.string().trim().max(2000).nullable().optional(),
  defectClosureVerification: z.string().trim().max(10000).nullable().optional(),
  frequencyDays: z.record(z.string(), z.number().int().min(1).max(3650)).optional(),
}).strict();

const createSchema = z.object({
  checkType: z.enum(CHECK_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result: z.enum(["pass", "fail"]),
  siteId: z.number().int().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  performedBy: z.string().max(200).nullable().optional(),
  staffRosterId: z.number().int().positive().nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checkType: true });

/** Returns the site row if it belongs to the tenant, or null. */
async function fetchClientSite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return null;
  const [site] = await db
    .select({ id: sitesTable.id, departmentId: sitesTable.departmentId })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  return site ?? null;
}

/**
 * Two-step site access check. Returns:
 *   null        → no siteId supplied; no check needed
 *   "not_found" → siteId does not belong to this client (→ 400)
 *   "forbidden" → site is in a different department (→ 403)
 *   "ok"        → access granted
 */
async function checkSiteAccess(
  siteId: number | null | undefined,
  clientId: number,
  deptId: number | null,
): Promise<null | "not_found" | "forbidden" | "ok"> {
  if (siteId == null) return null;
  const site = await fetchClientSite(siteId, clientId);
  if (!site) return "not_found";
  if (deptId !== null && site.departmentId !== null && site.departmentId !== deptId) return "forbidden";
  return "ok";
}

/** Build the subquery that limits checks to sites accessible to the user. */
function allowedSitesSubquery(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
    ));
}

// GET /api/fire-safety?checkType=&siteId=
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const conditions = [eq(fireSafetyChecksTable.clientId, clientId)];
  const { checkType, siteId } = req.query as { checkType?: string; siteId?: string };
  if (checkType && (CHECK_TYPES as readonly string[]).includes(checkType)) {
    conditions.push(eq(fireSafetyChecksTable.checkType, checkType));
  }
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(fireSafetyChecksTable.siteId, parseInt(siteId)));
  }

  // Department scoping: staff/viewers only see checks for sites in their dept
  // (or for checks not linked to any site).
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(fireSafetyChecksTable.siteId), inArray(fireSafetyChecksTable.siteId, allowedSitesSubquery(clientId, deptId))) as any,
    );
  }

  const rows = await db
    .select()
    .from(fireSafetyChecksTable)
    .where(and(...conditions))
    .orderBy(desc(fireSafetyChecksTable.checkDate), desc(fireSafetyChecksTable.id));

  res.json(rows);
});

// GET /api/fire-safety/status?siteId=
router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const selectedSiteId = parseSiteId(req.query.siteId);
  if (selectedSiteId === undefined) return res.status(400).json({ error: "Invalid site" });
  // The site's control profile sets the cadence, so the caller must be able to
  // see that site before any of it is returned.
  const siteAccess = await checkSiteAccess(selectedSiteId, clientId, getActiveDepartmentId(req));
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });

  // Each site is judged on its own checks and risk-assessed frequencies. The
  // all-sites view shows the worst site per check type and how many sites are
  // not up to date, so one site's check cannot make another look compliant.
  const deptId = getActiveDepartmentId(req);
  const accessibleSiteIds = deptId === null ? null
    : (await allowedSitesSubquery(clientId, deptId)).map(site => site.id);
  const statuses = worstFireStatusByType(
    await getFireSiteStatuses(clientId, { siteId: selectedSiteId, accessibleSiteIds }),
  );
  if (statuses.length === 0) {
    // No site is visible to this user, so nothing has been recorded for them.
    return res.json(CHECK_TYPES.map(checkType => ({
      checkType, frequencyDays: FREQUENCY_DAYS[checkType], lastDate: null, lastResult: null, dueDate: null,
      status: "never" as const, siteId: null, siteName: null, siteCount: 0, sitesAffected: 0,
    })));
  }
  res.json(statuses);
});

// POST /api/fire-safety
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  const performer = await resolveStaffPerformer(clientId, data.staffRosterId, data.performedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });

  const deptId = getActiveDepartmentId(req);
  const siteAccess = await checkSiteAccess(data.siteId, clientId, deptId);
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });

  const [inserted] = await db
    .insert(fireSafetyChecksTable)
    .values({
      clientId,
      checkType: data.checkType,
      checkDate: data.checkDate,
      result: data.result,
      siteId: data.siteId ?? null,
      location: data.location ?? null,
      notes: data.notes ?? null,
       performedBy: performer.performedBy,
       staffRosterId: performer.staffRosterId,
      createdBy: req.currentUser!.id,
    })
    .returning();

  await appendAuditEvent(req, { clientId, entityType: "fire_safety_check", entityId: inserted.id, action: "created", after: inserted });
  res.status(201).json(inserted);
});

// PUT /api/fire-safety/:id
router.put("/:id", requireAuth, denyViewers, async (req, res, next) => {
  // Keep the config route below the CRUD block without treating "config" as
  // a numeric check id.
  if (req.params.id === "config") return next();
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  // Fetch the existing record to verify dept access before and after mutation.
  const [existing] = await db
    .select()
    .from(fireSafetyChecksTable)
    .where(and(eq(fireSafetyChecksTable.id, id), eq(fireSafetyChecksTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  // Current record's site must be accessible to the user
  const existingAccess = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (existingAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  // If updating siteId, the new site must also pass both checks
  if ("siteId" in parsed.data) {
    const newAccess = await checkSiteAccess(parsed.data.siteId, clientId, deptId);
    if (newAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (newAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }
  const performer = await resolveStaffPerformerUpdate(clientId, parsed.data.staffRosterId, parsed.data.performedBy,
    existing.staffRosterId, existing.performedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });

  const [updated] = await db
    .update(fireSafetyChecksTable)
    .set({ ...parsed.data, ...(performer ?? {}), updatedAt: new Date() })
    .where(and(eq(fireSafetyChecksTable.id, id), eq(fireSafetyChecksTable.clientId, clientId)))
    .returning();

  if (!updated) return res.status(404).json({ error: "Not found" });
  await appendAuditEvent(req, { clientId, entityType: "fire_safety_check", entityId: id, action: "updated", before: existing, after: updated });
  res.json(updated);
});

// DELETE /api/fire-safety/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db
    .select()
    .from(fireSafetyChecksTable)
    .where(and(eq(fireSafetyChecksTable.id, id), eq(fireSafetyChecksTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  const access = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });

  await db
    .delete(fireSafetyChecksTable)
    .where(and(eq(fireSafetyChecksTable.id, id), eq(fireSafetyChecksTable.clientId, clientId)));

  await appendAuditEvent(req, { clientId, entityType: "fire_safety_check", entityId: id, action: "deleted", before: existing });
  res.status(204).end();
});

// ── Template config ───────────────────────────────────────────────────────────
const FIRE_CONFIG_KEYS = [
  "fire_escape_routes",       // JSON: [{name:string, location:string}]
  "fire_alarm_zones",         // JSON: string[]
  "fire_extinguisher_points", // JSON: string[]
  "fire_show_drill",          // "true"|"false"
  "fire_default_performer",
  "fire_frequency_days",     // JSON: check type -> risk-assessed interval in days
] as const;

const FIRE_DEFAULT_CONFIG = {
  fire_escape_routes: "",
  fire_alarm_zones: "",
  fire_extinguisher_points: "",
  fire_show_drill: "true",
  fire_default_performer: "",
  fire_frequency_days: JSON.stringify(FREQUENCY_DAYS),
};

function parseSiteId(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function getFireProfile(clientId: number, siteId: number) {
  const [row] = await db.select({ profile: trackControlProfilesTable.profile })
    .from(trackControlProfilesTable)
    .where(and(
      eq(trackControlProfilesTable.clientId, clientId),
      eq(trackControlProfilesTable.siteId, siteId),
      eq(trackControlProfilesTable.module, FIRE_PROFILE_MODULE),
    )).limit(1);
  return row?.profile ?? null;
}

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = parseSiteId(req.query.siteId);
  if (siteId === undefined) return res.status(400).json({ error: "Invalid site" });
  if (siteId != null) {
    const access = await checkSiteAccess(siteId, clientId, getActiveDepartmentId(req));
    if (access === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (access === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...FIRE_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (FIRE_CONFIG_KEYS.includes(row.key as (typeof FIRE_CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }
  const profile = siteId == null ? null : await getFireProfile(clientId, siteId);
  res.json({ ...config, controlProfile: profile, siteId });
});

router.put("/config", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = parseSiteId(req.query.siteId);
  if (siteId === undefined) return res.status(400).json({ error: "Invalid site" });
  if (siteId != null) {
    const access = await checkSiteAccess(siteId, clientId, getActiveDepartmentId(req));
    if (access === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (access === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }
  const updates = req.body as Record<string, unknown>;
  if (updates.controlProfile !== undefined) {
    if (siteId == null) return res.status(400).json({ error: "A site is required for a control profile" });
    const profile = fireProfileSchema.safeParse(updates.controlProfile);
    if (!profile.success) return res.status(400).json({ error: profile.error.flatten() });
    await db.insert(trackControlProfilesTable).values({
      clientId, siteId, module: FIRE_PROFILE_MODULE, profile: profile.data,
    }).onConflictDoUpdate({
      target: [trackControlProfilesTable.clientId, trackControlProfilesTable.siteId, trackControlProfilesTable.module],
      set: { profile: profile.data, updatedAt: new Date() },
    });
  }
  for (const key of FIRE_CONFIG_KEYS) {
    if (key in updates && typeof updates[key] === "string") {
      const existing = await db.select({ id: appSettingsTable.clientId }).from(appSettingsTable)
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key))).limit(1);
      if (existing.length > 0) {
        await db.update(appSettingsTable).set({ value: updates[key] as string, updatedAt: new Date() })
          .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
      } else {
        await db.insert(appSettingsTable).values({ clientId, key, value: updates[key] as string });
      }
    }
  }
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...FIRE_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (FIRE_CONFIG_KEYS.includes(row.key as (typeof FIRE_CONFIG_KEYS)[number]) && row.value != null) config[row.key] = row.value;
  }
  res.json({ ...config, controlProfile: siteId == null ? null : await getFireProfile(clientId, siteId), siteId });
});

export default router;
