import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { fireSafetyChecksTable, fireCallPointsTable, sitesTable, appSettingsTable, trackControlProfilesTable } from "@workspace/db/schema";
import type { FireSafetyCheck } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, denyViewers, requireClientAdmin, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { appendAuditEvent } from "../lib/audit";
import { siteVisibleToDepartment, sitesTableVisibleTo } from "../lib/departmentSites";
import { clientEntryFrom, clientEntryIdSchema, isUniqueViolation, respondToStoredEntry } from "../lib/clientEntryReplay";
import { resolveStaffPerformer, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import { ACTIVE_FIRE_CHECK_TYPES, FIRE_CHECK_TYPES, FIRE_FREQUENCY_DAYS, RETIRED_FIRE_CHECK_TYPES, effectiveFireFrequencies, getFireSiteStatuses, worstFireStatusByType } from "../lib/checkReminders";
import { getAccountToday } from "../lib/accountClock";
import { callPointLabel, callPointRotation } from "../lib/fireCallPointRotation";
import { SOUND_LEVEL_METHODS } from "../lib/fireSoundLevel";
import {
  DRILL_ATTENDANCE_MONTHS, listDrillAttendees, resolveDrillAttendees, saveDrillAttendees, staffDrillStatuses,
} from "../lib/fireDrillAttendance";

const router = Router();

const CHECK_TYPES = FIRE_CHECK_TYPES;

// Default check frequencies, in days
const FREQUENCY_DAYS = FIRE_FREQUENCY_DAYS;

const FIRE_PROFILE_MODULE = "fire";
// The Template form sends "" for an untouched date or nation; store that as "not set".
const blankAsNull = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(v => (v === "" ? null : v), schema);
const fireProfileSchema = z.object({
  riskAssessmentReference: z.string().trim().max(2000).nullable().optional(),
  riskAssessmentDate: blankAsNull(z.string().date().nullable().optional()),
  nextReviewDate: blankAsNull(z.string().date().nullable().optional()),
  responsiblePerson: z.string().trim().max(500).nullable().optional(),
  ukNation: blankAsNull(z.enum(["england", "scotland", "wales", "northern_ireland"]).nullable().optional()),
  evacuationPeepArrangements: z.string().trim().max(10000).nullable().optional(),
  maintenanceEvidenceReference: z.string().trim().max(2000).nullable().optional(),
  defectClosureVerification: z.string().trim().max(10000).nullable().optional(),
  frequencyDays: z.record(z.string(), z.number().int().min(1).max(3650)).optional(),
}).strict();

/** Whether night staff took part in a fire drill. */
const NIGHT_STAFF_VALUES = ["included", "not_included", "no_night_staff"] as const;

const createSchema = z.object({
  checkType: z.enum(CHECK_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result: z.enum(["pass", "fail"]),
  siteId: z.number().int().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  performedBy: z.string().max(200).nullable().optional(),
  staffRosterId: z.number().int().positive().nullable().optional(),
  // Weekly alarm tests: a call point from the site's list, or its name typed
  // in when the site has no list yet.
  callPointId: z.number().int().positive().nullable().optional(),
  callPoint: z.string().trim().max(200).nullable().optional(),
  // Fire drills only: night staff, the time of the drill ("HH:MM"), how long
  // the evacuation took in seconds, and the roster ids of the staff present.
  nightStaff: z.enum(NIGHT_STAFF_VALUES).nullable().optional(),
  drillTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  evacuationSeconds: z.number().int().min(1).max(24 * 60 * 60).nullable().optional(),
  staffPresentIds: z.array(z.number().int().positive()).max(2000).optional(),
  // Weekly alarm tests, optional: the sound level heard (lib/fireSoundLevel).
  soundLevelDb: z.number().min(20).max(140).nullable().optional(),
  soundLevelMethod: z.enum(SOUND_LEVEL_METHODS).nullable().optional(),
  soundLevelBedhead: z.boolean().nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checkType: true });

type FireDetails = Pick<FireSafetyCheck,
  "callPointId" | "callPoint" | "nightStaff" | "drillTime" | "evacuationSeconds"
  | "soundLevelDb" | "soundLevelMethod" | "soundLevelBedhead">;
type FireDetailInput = {
  callPointId?: number | null; callPoint?: string | null; nightStaff?: FireDetails["nightStaff"];
  drillTime?: string | null; evacuationSeconds?: number | null; notes?: string | null;
  soundLevelDb?: number | null; soundLevelMethod?: FireDetails["soundLevelMethod"]; soundLevelBedhead?: boolean | null;
};

/**
 * The call point and drill fields a check stores. A weekly alarm test must say
 * which call point was used. A drill must say whether night staff took part,
 * the time of the drill, how long the evacuation took, and the improvements
 * required (the notes). Other check types store none of these. On an edit,
 * `existing` is the stored record: older records saved before these fields
 * existed may stay blank, but a recorded answer cannot be removed.
 */
async function resolveFireDetails(
  clientId: number, checkType: string, siteId: number | null, input: FireDetailInput,
  existing?: FireSafetyCheck,
): Promise<FireDetails | { error: string }> {
  const details: FireDetails = {
    callPointId: null, callPoint: null, nightStaff: null, drillTime: null, evacuationSeconds: null,
    soundLevelDb: null, soundLevelMethod: null, soundLevelBedhead: null,
  };
  if (checkType === "alarm") {
    let callPointId = existing?.callPointId ?? null;
    let callPoint = existing?.callPoint ?? null;
    if (input.callPointId !== undefined || input.callPoint !== undefined) {
      callPointId = input.callPointId ?? null;
      callPoint = callPointId == null ? (input.callPoint?.trim() || null) : null;
    }
    if (callPointId != null) {
      const [point] = await db.select().from(fireCallPointsTable)
        .where(and(eq(fireCallPointsTable.id, callPointId), eq(fireCallPointsTable.clientId, clientId)))
        .limit(1);
      // An archived call point can stay on the test that already names it,
      // but is not offered for new tests.
      const kept = existing?.callPointId === callPointId;
      if (!point || (point.archivedAt && !kept)) return { error: "Choose a call point from this site's list" };
      if ((point.siteId ?? null) !== siteId) return { error: "That call point is at a different site" };
      callPoint = kept && existing?.callPoint ? existing.callPoint : callPointLabel(point);
    }
    if (!callPoint && (!existing || existing.callPoint)) return { error: "Say which call point was tested" };
    details.callPointId = callPointId;
    details.callPoint = callPoint;
    // The sound level is optional. Sending a blank level clears all three.
    const soundLevelDb = input.soundLevelDb !== undefined ? input.soundLevelDb : existing?.soundLevelDb ?? null;
    if (soundLevelDb != null) {
      details.soundLevelDb = Math.round(soundLevelDb * 10) / 10;
      details.soundLevelMethod = (input.soundLevelMethod !== undefined ? input.soundLevelMethod : existing?.soundLevelMethod) ?? "meter";
      details.soundLevelBedhead = (input.soundLevelBedhead !== undefined ? input.soundLevelBedhead : existing?.soundLevelBedhead) ?? false;
    }
  }
  if (checkType === "fire_drill") {
    const nightStaff = input.nightStaff !== undefined ? input.nightStaff : existing?.nightStaff ?? null;
    if (!nightStaff && (!existing || existing.nightStaff)) return { error: "Say whether night staff took part in the drill" };
    details.nightStaff = nightStaff;
    const drillTime = input.drillTime !== undefined ? input.drillTime : existing?.drillTime ?? null;
    if (!drillTime && (!existing || existing.drillTime)) return { error: "Give the time of the drill" };
    details.drillTime = drillTime;
    const evacuationSeconds = input.evacuationSeconds !== undefined ? input.evacuationSeconds : existing?.evacuationSeconds ?? null;
    if (evacuationSeconds == null && (!existing || existing.evacuationSeconds != null)) {
      return { error: "Give the time taken to evacuate" };
    }
    details.evacuationSeconds = evacuationSeconds;
    const notes = input.notes !== undefined ? input.notes : existing?.notes ?? null;
    if (!notes?.trim() && (!existing || existing.notes?.trim())) {
      return { error: "Write the improvements required, or notes, for the drill" };
    }
  }
  return details;
}
// Creation only: the mobile outbox's device entry ID (see clientEntryReplay).
const postSchema = createSchema.extend({ clientEntryId: clientEntryIdSchema.optional() });

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
  if (!(await siteVisibleToDepartment(site, deptId))) return "forbidden";
  return "ok";
}

/** Build the subquery that limits checks to sites accessible to the user. */
function allowedSitesSubquery(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      sitesTableVisibleTo(deptId),
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

  const attendees = await listDrillAttendees(clientId, rows.filter(row => row.checkType === "fire_drill").map(row => row.id));
  res.json(rows.map(row => ({ ...row, staffPresent: attendees.get(row.id) ?? [] })));
});

// GET /api/fire-safety/drill-attendance?siteId=
// Each active roster member with the latest fire drill they were ticked
// present at, so FireTrack and TrainTrack can show who has not taken part in
// one in the last 12 months. Viewers see only their own training, so not this.
router.get("/drill-attendance", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (req.currentUser!.role === "client_viewer") return res.status(403).json({ error: "Forbidden" });
  const selectedSiteId = parseSiteId(req.query.siteId);
  if (selectedSiteId === undefined) return res.status(400).json({ error: "Invalid site" });
  const deptId = getActiveDepartmentId(req);
  const siteAccess = await checkSiteAccess(selectedSiteId, clientId, deptId);
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  const today = await getAccountToday(clientId);
  const staff = await staffDrillStatuses(clientId, deptId, selectedSiteId, today);
  res.json({ periodMonths: DRILL_ATTENDANCE_MONTHS, staff });
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
    return res.json(ACTIVE_FIRE_CHECK_TYPES.map(checkType => ({
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

  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  // Older records of a retired check stay editable, but no new ones are made.
  if (RETIRED_FIRE_CHECK_TYPES.includes(data.checkType)) {
    return res.status(400).json({
      error: data.checkType === "alarm_panel"
        ? "The alarm panel is now checked on the premises opening and closing checks."
        : "Contractor services are now recorded on their compliance check (Compliance Checks), which FireTrack shows.",
      code: "FIRE_CHECK_TYPE_RETIRED",
    });
  }
  const performer = await resolveStaffPerformer(clientId, data.staffRosterId, data.performedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });

  const deptId = getActiveDepartmentId(req);
  const siteAccess = await checkSiteAccess(data.siteId, clientId, deptId);
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });

  const details = await resolveFireDetails(clientId, data.checkType, data.siteId ?? null, data);
  if ("error" in details) return res.status(400).json({ error: details.error });
  const isDrill = data.checkType === "fire_drill";
  const present = isDrill ? await resolveDrillAttendees(clientId, deptId, data.staffPresentIds ?? []) : { attendees: [] };
  if ("error" in present) return res.status(400).json({ error: present.error });

  const userId = req.currentUser!.id;
  const entry = clientEntryFrom(data);
  const storedEntry = async () => entry && (await db.select().from(fireSafetyChecksTable)
    .where(and(eq(fireSafetyChecksTable.clientId, clientId), eq(fireSafetyChecksTable.clientEntryId, entry.id)))
    .limit(1))[0];
  const prior = await storedEntry();
  if (entry && prior) return respondToStoredEntry(res, prior, userId, entry);

  let inserted;
  try {
    inserted = await db.transaction(async (tx) => {
      const [row] = await tx
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
          ...details,
          createdBy: userId,
          clientEntryId: entry?.id ?? null,
          clientEntryHash: entry?.hash ?? null,
        })
        .returning();
      if (isDrill) await saveDrillAttendees(tx, clientId, row.id, present.attendees);
      return row;
    });
  } catch (err) {
    // A concurrent replay of the same device entry won the insert.
    const raced = entry && isUniqueViolation(err) ? await storedEntry() : undefined;
    if (entry && raced) return respondToStoredEntry(res, raced, userId, entry);
    throw err;
  }

  const staffPresent = isDrill ? (await listDrillAttendees(clientId, [inserted.id])).get(inserted.id) ?? [] : [];
  await appendAuditEvent(req, { clientId, entityType: "fire_safety_check", entityId: inserted.id, action: "created", after: { ...inserted, staffPresent } });
  res.status(201).json({ ...inserted, staffPresent });
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
  const {
    callPointId, callPoint, nightStaff, drillTime, evacuationSeconds, staffPresentIds,
    soundLevelDb, soundLevelMethod, soundLevelBedhead, ...changes
  } = parsed.data;
  const siteId = "siteId" in parsed.data ? parsed.data.siteId ?? null : existing.siteId;
  const details = await resolveFireDetails(clientId, existing.checkType, siteId, {
    callPointId, callPoint, nightStaff, drillTime, evacuationSeconds, notes: changes.notes,
    soundLevelDb, soundLevelMethod, soundLevelBedhead,
  }, existing);
  if ("error" in details) return res.status(400).json({ error: details.error });
  const isDrill = existing.checkType === "fire_drill";
  // Leaving the list out keeps who was present as recorded.
  const present = isDrill && staffPresentIds !== undefined
    ? await resolveDrillAttendees(clientId, deptId, staffPresentIds, id) : null;
  if (present && "error" in present) return res.status(400).json({ error: present.error });

  const before = isDrill ? (await listDrillAttendees(clientId, [id])).get(id) ?? [] : [];
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(fireSafetyChecksTable)
      .set({ ...changes, ...(performer ?? {}), ...details, updatedAt: new Date() })
      .where(and(eq(fireSafetyChecksTable.id, id), eq(fireSafetyChecksTable.clientId, clientId)))
      .returning();
    if (row && present) await saveDrillAttendees(tx, clientId, id, present.attendees);
    return row;
  });

  if (!updated) return res.status(404).json({ error: "Not found" });
  const staffPresent = isDrill ? (await listDrillAttendees(clientId, [id])).get(id) ?? [] : [];
  await appendAuditEvent(req, {
    clientId, entityType: "fire_safety_check", entityId: id, action: "updated",
    before: { ...existing, staffPresent: before }, after: { ...updated, staffPresent },
  });
  res.json({ ...updated, staffPresent });
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

// ── Call points ───────────────────────────────────────────────────────────────
// Managers list each site's manual call points once; weekly alarm tests pick
// the one they used. Call points are archived rather than deleted so the
// tests that name them keep their link (records are kept for five years).

const callPointNameSchema = z.string().trim().min(1).max(200);
const callPointLocationSchema = z.string().trim().max(200).nullable().optional()
  .transform(value => value === undefined ? undefined : value || null);
const createCallPointSchema = z.object({
  siteId: z.number().int().positive().nullable(),
  name: callPointNameSchema,
  location: callPointLocationSchema,
  sleepingArea: z.boolean().optional(),
}).strict();
const updateCallPointSchema = z.object({
  name: callPointNameSchema.optional(),
  location: callPointLocationSchema,
  sleepingArea: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict();
const orderCallPointsSchema = z.object({
  siteId: z.number().int().positive().nullable(),
  ids: z.array(z.number().int().positive()).min(1).max(1000),
}).strict();

/**
 * Call points in rotation order, with when each was last used for an alarm
 * test, which one is next in turn at its site, and which have not been tested
 * within one full round (see fireCallPointRotation).
 */
async function listCallPoints(clientId: number, conditions: ReturnType<typeof eq>[]) {
  const lastTest = db.select({
    callPointId: fireSafetyChecksTable.callPointId,
    lastTestedDate: sql<string>`max(${fireSafetyChecksTable.checkDate})`.as("last_tested_date"),
  }).from(fireSafetyChecksTable)
    .where(and(eq(fireSafetyChecksTable.clientId, clientId), eq(fireSafetyChecksTable.checkType, "alarm")))
    .groupBy(fireSafetyChecksTable.callPointId)
    .as("last_test");
  const rows = await db.select({
    id: fireCallPointsTable.id,
    siteId: fireCallPointsTable.siteId,
    name: fireCallPointsTable.name,
    location: fireCallPointsTable.location,
    sortOrder: fireCallPointsTable.sortOrder,
    sleepingArea: fireCallPointsTable.sleepingArea,
    archivedAt: fireCallPointsTable.archivedAt,
    createdAt: fireCallPointsTable.createdAt,
    lastTestedDate: lastTest.lastTestedDate,
  }).from(fireCallPointsTable)
    .leftJoin(lastTest, eq(lastTest.callPointId, fireCallPointsTable.id))
    .where(and(eq(fireCallPointsTable.clientId, clientId), ...conditions))
    .orderBy(fireCallPointsTable.sortOrder, fireCallPointsTable.name, fireCallPointsTable.id);
  if (!rows.length) return [];

  // The rotation is worked out over each site's whole list, whatever the
  // filter, so a single call point still knows whether it is next in turn.
  const siteIds = [...new Set(rows.map(row => row.siteId).filter((id): id is number => id != null))];
  const siteCondition = siteIds.length
    ? sql`(p.site_id IS NULL OR p.site_id IN (${sql.join(siteIds.map(id => sql`${id}`), sql`, `)}))`
    : sql`p.site_id IS NULL`;
  const [pointRows, latestRows, settingRows, profileRows, today] = await Promise.all([
    db.execute(sql`
      SELECT p.id, p.site_id, p.sort_order, p.archived_at IS NOT NULL AS archived,
             (SELECT max(c.check_date)::text FROM fire_safety_checks c
              WHERE c.client_id = p.client_id AND c.check_type = 'alarm' AND c.call_point_id = p.id) AS last_tested_date
      FROM fire_call_points p WHERE p.client_id = ${clientId} AND ${siteCondition}
    `),
    db.execute(sql`
      SELECT DISTINCT ON (p.site_id) p.site_id, c.call_point_id
      FROM fire_safety_checks c JOIN fire_call_points p ON p.id = c.call_point_id AND p.client_id = c.client_id
      WHERE c.client_id = ${clientId} AND c.check_type = 'alarm' AND ${siteCondition}
      ORDER BY p.site_id, c.check_date DESC, c.id DESC
    `),
    db.select({ value: appSettingsTable.value }).from(appSettingsTable)
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, "fire_frequency_days"))).limit(1),
    siteIds.length ? db.select({ siteId: trackControlProfilesTable.siteId, profile: trackControlProfilesTable.profile })
      .from(trackControlProfilesTable)
      .where(and(eq(trackControlProfilesTable.clientId, clientId), eq(trackControlProfilesTable.module, FIRE_PROFILE_MODULE),
        inArray(trackControlProfilesTable.siteId, siteIds)))
      : Promise.resolve([]),
    getAccountToday(clientId),
  ]);
  const profiles = new Map(profileRows.map(row => [row.siteId, row.profile]));
  const lastPointBySite = new Map(((latestRows.rows ?? []) as { site_id: number | null; call_point_id: number }[])
    .map(row => [row.site_id == null ? null : Number(row.site_id), Number(row.call_point_id)]));
  const rotation = callPointRotation(
    ((pointRows.rows ?? []) as { id: number; site_id: number | null; sort_order: number; archived: boolean; last_tested_date: string | null }[])
      .map(row => ({
        id: Number(row.id), siteId: row.site_id == null ? null : Number(row.site_id), sortOrder: Number(row.sort_order),
        archived: Boolean(row.archived), lastTestedDate: row.last_tested_date ? String(row.last_tested_date).slice(0, 10) : null,
      })),
    lastPointBySite,
    siteId => effectiveFireFrequencies(settingRows[0]?.value ?? null, siteId == null ? null : profiles.get(siteId) ?? null).alarm,
    today,
  );
  return rows.map(row => ({
    ...row,
    lastTestedDate: row.lastTestedDate ? String(row.lastTestedDate).slice(0, 10) : null,
    nextInTurn: rotation.nextIds.has(row.id),
    notTestedThisRound: rotation.notTestedThisRound.has(row.id),
  }));
}

/** The next free place at the end of a site's rotation. */
async function nextSortOrder(clientId: number, siteId: number | null) {
  const [row] = await db.select({ highest: sql<number>`coalesce(max(${fireCallPointsTable.sortOrder}), 0)` })
    .from(fireCallPointsTable)
    .where(and(eq(fireCallPointsTable.clientId, clientId),
      siteId == null ? isNull(fireCallPointsTable.siteId) : eq(fireCallPointsTable.siteId, siteId)));
  return Number(row?.highest ?? 0) + 1;
}

async function duplicateCallPoint(clientId: number, siteId: number | null, name: string, exceptId?: number) {
  const [row] = await db.select({ id: fireCallPointsTable.id }).from(fireCallPointsTable).where(and(
    eq(fireCallPointsTable.clientId, clientId),
    siteId == null ? isNull(fireCallPointsTable.siteId) : eq(fireCallPointsTable.siteId, siteId),
    isNull(fireCallPointsTable.archivedAt),
    sql`lower(${fireCallPointsTable.name}) = lower(${name})`,
    ...(exceptId ? [sql`${fireCallPointsTable.id} <> ${exceptId}`] : []),
  )).limit(1);
  return Boolean(row);
}

// GET /api/fire-safety/call-points?siteId=&includeArchived=true
router.get("/call-points", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const noSite = req.query.siteId === "none";
  const siteId = noSite ? null : parseSiteId(req.query.siteId);
  if (siteId === undefined) return res.status(400).json({ error: "Invalid site" });
  const deptId = getActiveDepartmentId(req);
  const conditions = [];
  if (siteId != null) {
    const access = await checkSiteAccess(siteId, clientId, deptId);
    if (access === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (access === "forbidden") return res.status(403).json({ error: "Site not accessible" });
    conditions.push(eq(fireCallPointsTable.siteId, siteId));
  } else if (noSite) {
    conditions.push(isNull(fireCallPointsTable.siteId));
  } else if (deptId !== null) {
    conditions.push(or(isNull(fireCallPointsTable.siteId), inArray(fireCallPointsTable.siteId, allowedSitesSubquery(clientId, deptId))) as any);
  }
  if (req.query.includeArchived !== "true") conditions.push(isNull(fireCallPointsTable.archivedAt) as any);
  res.json(await listCallPoints(clientId, conditions));
});

// POST /api/fire-safety/call-points — added at the end of the site's rotation.
router.post("/call-points", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = createCallPointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the call point a name" });
  const { siteId, name, location, sleepingArea } = parsed.data;
  const access = await checkSiteAccess(siteId, clientId, getActiveDepartmentId(req));
  if (access === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (access === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  if (await duplicateCallPoint(clientId, siteId, name)) {
    return res.status(409).json({ error: "This site already has a call point with that name" });
  }
  const [created] = await db.insert(fireCallPointsTable)
    .values({
      clientId, siteId, name, location: location ?? null, sleepingArea: sleepingArea ?? false,
      sortOrder: await nextSortOrder(clientId, siteId), createdBy: req.currentUser!.id,
    })
    .returning();
  await appendAuditEvent(req, { clientId, entityType: "fire_call_point", entityId: created.id, action: "created", after: created });
  const [withRotation] = await listCallPoints(clientId, [eq(fireCallPointsTable.id, created.id)]);
  res.status(201).json(withRotation ?? { ...created, lastTestedDate: null, nextInTurn: false, notTestedThisRound: true });
});

// PUT /api/fire-safety/call-points/order — the site's rotation order: every
// call point still in use at the site, first to last. Archived ones keep their
// old place and a restored one goes to the end.
router.put("/call-points/order", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = orderCallPointsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid order" });
  const { siteId, ids } = parsed.data;
  const access = await checkSiteAccess(siteId, clientId, getActiveDepartmentId(req));
  if (access === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (access === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  const siteCondition = siteId == null ? isNull(fireCallPointsTable.siteId) : eq(fireCallPointsTable.siteId, siteId);
  const updated = await db.transaction(async (tx) => {
    const current = await tx.select({ id: fireCallPointsTable.id, sortOrder: fireCallPointsTable.sortOrder })
      .from(fireCallPointsTable)
      .where(and(eq(fireCallPointsTable.clientId, clientId), siteCondition, isNull(fireCallPointsTable.archivedAt)))
      .for("update");
    const currentIds = new Set(current.map(row => row.id));
    if (ids.length !== currentIds.size || new Set(ids).size !== ids.length || ids.some(id => !currentIds.has(id))) return null;
    const before = Object.fromEntries(current.map(row => [row.id, row.sortOrder]));
    for (const [index, id] of ids.entries()) {
      if (before[id] === index + 1) continue;
      await tx.update(fireCallPointsTable).set({ sortOrder: index + 1, updatedAt: new Date() })
        .where(and(eq(fireCallPointsTable.id, id), eq(fireCallPointsTable.clientId, clientId)));
    }
    return { before, after: Object.fromEntries(ids.map((id, index) => [id, index + 1])) };
  });
  if (!updated) return res.status(409).json({ error: "The call point list has changed. Refresh and try again." });
  await appendAuditEvent(req, {
    clientId, entityType: "fire_call_point_order", entityId: siteId ?? 0, action: "updated",
    before: { siteId, order: updated.before }, after: { siteId, order: updated.after },
  });
  res.json(await listCallPoints(clientId, [siteCondition as any, isNull(fireCallPointsTable.archivedAt) as any]));
});

// PUT /api/fire-safety/call-points/:id — rename, move, archive or restore. The
// site is fixed: a call point at another site is a different call point.
router.put("/call-points/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "Not found" });
  const parsed = updateCallPointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const [existing] = await db.select().from(fireCallPointsTable)
    .where(and(eq(fireCallPointsTable.id, id), eq(fireCallPointsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (await checkSiteAccess(existing.siteId, clientId, getActiveDepartmentId(req)) === "forbidden") {
    return res.status(404).json({ error: "Not found" });
  }
  const name = parsed.data.name ?? existing.name;
  const location = parsed.data.location === undefined ? existing.location : parsed.data.location;
  const sleepingArea = parsed.data.sleepingArea ?? existing.sleepingArea;
  const archivedAt = parsed.data.archived === undefined ? existing.archivedAt
    : parsed.data.archived ? existing.archivedAt ?? new Date() : null;
  if (!archivedAt && await duplicateCallPoint(clientId, existing.siteId, name, id)) {
    return res.status(409).json({ error: "This site already has a call point with that name" });
  }
  // A restored call point rejoins the rotation at the end.
  const sortOrder = existing.archivedAt && !archivedAt ? await nextSortOrder(clientId, existing.siteId) : existing.sortOrder;
  const [updated] = await db.update(fireCallPointsTable)
    .set({ name, location, sleepingArea, archivedAt, sortOrder, updatedAt: new Date() })
    .where(and(eq(fireCallPointsTable.id, id), eq(fireCallPointsTable.clientId, clientId)))
    .returning();
  await appendAuditEvent(req, { clientId, entityType: "fire_call_point", entityId: id, action: "updated", before: existing, after: updated });
  const [withRotation] = await listCallPoints(clientId, [eq(fireCallPointsTable.id, id)]);
  res.json(withRotation ?? { ...updated, lastTestedDate: null, nextInTurn: false, notTestedThisRound: false });
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
    if (!profile.success) {
      const issue = profile.error.issues[0];
      return res.status(400).json({
        error: `Invalid control profile: ${issue?.path.join(".") || "profile"} — ${issue?.message ?? "invalid value"}`,
        details: profile.error.flatten(),
      });
    }
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
