/**
 * GreenTrack daily checks (lib/greenkeepingChecks.ts): the greenkeeping shed
 * opening and closing checklists, the team that does them at each site, and
 * each machine's pre-start check or "not in use today" mark. Mounted under
 * /green-track with requireAuth and the GreenTrack service.
 *
 * The shed checklists are site records, scoped like the DailyTrack AM/PM
 * checklists: department-scoped people use only the sites their department
 * can see. Machines follow GreenTrack's own (tenant-only) scope.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { dailyChecklistsTable, sitesTable } from "@workspace/db/schema";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { denyViewers, getActiveDepartmentId, getClientId, requireClientAdmin } from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { resolveStaffPerformer, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import { saveDailyChecklist } from "../lib/dailyChecklistWrite";
import { checklistIncompleteReason, checklistItemSchema, createFailedChecklistItemActions, normaliseChecklistItems } from "../lib/dailyChecklistItems";
import { getAccountToday } from "../lib/accountClock";
import {
  GREENKEEPING_AREA, GREENKEEPING_CHECKLIST_TYPES, departmentsAtSites, getPreStartDay, isGreenkeepingChecklistType,
  loadGreenkeepingTeams,
} from "../lib/greenkeepingChecks";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

const createSchema = z.object({
  siteId: z.number().int().nullable().optional(),
  checklistType: z.enum(GREENKEEPING_CHECKLIST_TYPES),
  checkDate: z.string().regex(ISO_DATE),
  items: z.array(checklistItemSchema).optional(),
  completedBy: z.string().max(200).nullable().optional(),
  staffRosterId: z.number().int().positive().nullable().optional(),
  managerNote: z.string().max(2000).nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
});

// A checklist keeps its site and day.
const updateSchema = createSchema.partial().omit({ checklistType: true, checkDate: true, siteId: true });

function visibleSiteIds(clientId: number, departmentId: number) {
  return db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(departmentId)));
}

/**
 * Whether the caller may use this site: it belongs to the business and, for
 * department-scoped people, their department can see it. No site is allowed.
 */
async function siteUsable(siteId: unknown, clientId: number, departmentId: number | null): Promise<boolean> {
  if (siteId == null) return true;
  if (typeof siteId !== "number" || !Number.isInteger(siteId)) return false;
  const [row] = await db.select({ id: sitesTable.id }).from(sitesTable).where(and(
    eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId),
    ...(departmentId !== null ? [sitesTableVisibleTo(departmentId)] : []),
  )).limit(1);
  return Boolean(row);
}

function parseSiteId(value: unknown): number | null | "invalid" {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : "invalid";
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHED CHECKS — greenkeeping shed opening and closing checklists
// ═══════════════════════════════════════════════════════════════════════════════

// GET /green-track/shed-checks?siteId=&date=&type=
router.get("/shed-checks", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { siteId, date, type } = req.query as Record<string, string | undefined>;
  const site = parseSiteId(siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid siteId" });
  if (date && !ISO_DATE.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  if (type && !isGreenkeepingChecklistType(type)) return res.status(400).json({ error: "Invalid checklist type" });
  const conditions = [
    eq(dailyChecklistsTable.clientId, clientId),
    inArray(dailyChecklistsTable.checklistType, type ? [type] : [...GREENKEEPING_CHECKLIST_TYPES]),
  ];
  if (site !== null) conditions.push(eq(dailyChecklistsTable.siteId, site));
  if (date) conditions.push(eq(dailyChecklistsTable.checkDate, date));
  const departmentId = getActiveDepartmentId(req);
  if (departmentId !== null) {
    conditions.push(or(isNull(dailyChecklistsTable.siteId), inArray(dailyChecklistsTable.siteId, visibleSiteIds(clientId, departmentId)))!);
  }
  const rows = await db.select().from(dailyChecklistsTable).where(and(...conditions))
    .orderBy(desc(dailyChecklistsTable.checkDate), desc(dailyChecklistsTable.id)).limit(500);
  res.json(rows);
});

/** The shed checklist with this id, or null (not found, another kind, or a site the caller can't see). */
async function findShedCheck(req: Request, clientId: number) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [row] = await db.select().from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!row || !isGreenkeepingChecklistType(row.checklistType)) return null;
  if (!(await siteUsable(row.siteId, clientId, getActiveDepartmentId(req)))) return null;
  return row;
}

// GET /green-track/shed-checks/:id
router.get("/shed-checks/:id", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const row = await findShedCheck(req, clientId);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// POST /green-track/shed-checks — create, or update the day's draft
router.post("/shed-checks", denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  if (!(await siteUsable(data.siteId ?? null, clientId, getActiveDepartmentId(req)))) {
    return res.status(403).json({ error: "Site not accessible" });
  }
  const result = await saveDailyChecklist({
    clientId,
    siteId: data.siteId ?? null,
    checklistType: data.checklistType,
    checkDate: data.checkDate,
    items: data.items ? normaliseChecklistItems(data.items) : undefined,
    managerNote: data.managerNote,
    submittedAt: data.submittedAt ? new Date(data.submittedAt) : null,
    createdBy: req.currentUser!.id,
  }, (existing) => existing
    ? resolveStaffPerformerUpdate(clientId, data.staffRosterId, data.completedBy, existing.staffRosterId, existing.completedBy)
    : resolveStaffPerformer(clientId, data.staffRosterId, data.completedBy));
  if (result.outcome === "incomplete") return res.status(400).json({ error: result.reason, code: "CHECKLIST_INCOMPLETE" });
  if (result.outcome === "invalid_performer") return res.status(400).json({ error: "Invalid staff roster member" });
  if (result.outcome === "already_submitted") {
    return res.status(409).json({ error: "Checklist already submitted", code: "CHECKLIST_ALREADY_SUBMITTED", id: result.row.id });
  }
  res.status(result.outcome === "created" ? 201 : 200).json(result.row);
});

// PUT /green-track/shed-checks/:id — edit or submit a draft
router.put("/shed-checks/:id", denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const existing = await findShedCheck(req, clientId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Checklist already submitted" });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  const items = data.items ? normaliseChecklistItems(data.items) : undefined;
  if (data.submittedAt) {
    const reason = checklistIncompleteReason(items ?? existing.items);
    if (reason) return res.status(400).json({ error: reason, code: "CHECKLIST_INCOMPLETE" });
  }
  const performer = await resolveStaffPerformerUpdate(clientId, data.staffRosterId, data.completedBy, existing.staffRosterId, existing.completedBy);
  if (data.staffRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
  const row = await db.transaction(async (tx) => {
    // Only a draft moves to submitted, so two racing submits create one set of actions.
    const [updated] = await tx.update(dailyChecklistsTable).set({
      ...(items ? { items } : {}),
      ...(data.managerNote !== undefined ? { managerNote: data.managerNote } : {}),
      completedBy: performer?.performedBy ?? null,
      staffRosterId: performer?.staffRosterId ?? null,
      ...(data.submittedAt ? { submittedAt: new Date(data.submittedAt) } : {}),
      updatedAt: new Date(),
    }).where(and(eq(dailyChecklistsTable.id, existing.id), eq(dailyChecklistsTable.clientId, clientId), isNull(dailyChecklistsTable.submittedAt)))
      .returning();
    if (updated?.submittedAt) await createFailedChecklistItemActions(tx, updated, req.currentUser!.id);
    return updated;
  });
  if (!row) return res.status(409).json({ error: "Checklist already submitted" });
  res.json(row);
});

// DELETE /green-track/shed-checks/:id — drafts only
router.delete("/shed-checks/:id", denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const existing = await findShedCheck(req, clientId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Cannot delete a submitted checklist" });
  await db.delete(dailyChecklistsTable).where(and(
    eq(dailyChecklistsTable.id, existing.id), eq(dailyChecklistsTable.clientId, clientId), isNull(dailyChecklistsTable.submittedAt),
  ));
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEAM — which department does a site's shed checks
// ═══════════════════════════════════════════════════════════════════════════════

async function teamView(clientId: number, siteId: number) {
  const [teams, departments] = await Promise.all([
    loadGreenkeepingTeams(clientId, [siteId]),
    departmentsAtSites(clientId, [siteId]),
  ]);
  const team = teams.get(siteId);
  return {
    siteId,
    departmentId: team?.departmentId ?? null,
    departmentName: team?.departmentName ?? null,
    chosen: team?.chosen ?? false,
    departments: (departments.get(siteId) ?? []).map(({ id, name }) => ({ id, name })),
  };
}

// GET /green-track/shed-team?siteId=
router.get("/shed-team", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = parseSiteId(req.query.siteId);
  if (siteId === null || siteId === "invalid") return res.status(400).json({ error: "siteId is required" });
  if (!(await siteUsable(siteId, clientId, getActiveDepartmentId(req)))) return res.status(404).json({ error: "Site not found" });
  res.json(await teamView(clientId, siteId));
});

// PUT /green-track/shed-team { siteId, departmentId } — null goes back to matching by name
router.put("/shed-team", requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = z.object({
    siteId: z.number().int().positive(),
    departmentId: z.number().int().positive().nullable(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const { siteId, departmentId } = parsed.data;
  if (!(await siteUsable(siteId, clientId, null))) return res.status(404).json({ error: "Site not found" });
  if (departmentId === null) {
    await db.execute(sql`
      DELETE FROM daily_checklist_teams
      WHERE client_id = ${clientId} AND site_id = ${siteId} AND area = ${GREENKEEPING_AREA}
    `);
    return res.json(await teamView(clientId, siteId));
  }
  const available = (await departmentsAtSites(clientId, [siteId])).get(siteId) ?? [];
  if (!available.some((department) => department.id === departmentId)) {
    return res.status(400).json({ error: "That department does not work at this site" });
  }
  await db.execute(sql`
    INSERT INTO daily_checklist_teams (client_id, site_id, area, department_id, updated_by, updated_at)
    VALUES (${clientId}, ${siteId}, ${GREENKEEPING_AREA}, ${departmentId}, ${req.currentUser!.id}, now())
    ON CONFLICT (site_id, area)
      DO UPDATE SET department_id = EXCLUDED.department_id, updated_by = EXCLUDED.updated_by, updated_at = now()
  `);
  res.json(await teamView(clientId, siteId));
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-START — every machine checked, or marked not in use, each day
// ═══════════════════════════════════════════════════════════════════════════════

// GET /green-track/pre-start?date=&siteId=
router.get("/pre-start", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = parseSiteId(req.query.siteId);
  if (siteId === "invalid") return res.status(400).json({ error: "Invalid siteId" });
  const requested = typeof req.query.date === "string" ? req.query.date : "";
  if (requested && !ISO_DATE.test(requested)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const date = requested || await getAccountToday(clientId);
  const machines = await getPreStartDay(clientId, date, siteId === null ? null : [siteId]);
  const count = (status: string) => machines.filter((machine) => machine.status === status).length;
  res.json({
    date,
    machines,
    total: machines.length,
    checked: count("checked") + count("failed"),
    failed: count("failed"),
    notInUse: count("not_in_use"),
    todo: count("todo"),
  });
});

// POST /green-track/pre-start/not-in-use { machineId, checkDate, reason? }
router.post("/pre-start/not-in-use", denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = z.object({
    machineId: z.number().int().positive(),
    checkDate: z.string().regex(ISO_DATE),
    reason: z.string().trim().max(500).nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const { machineId, checkDate, reason } = parsed.data;
  const machine = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId} AND active = true
  `))[0];
  if (!machine) return res.status(404).json({ error: "Machine not found" });
  const checked = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT id FROM green_pre_use_checks WHERE machine_id = ${machineId} AND client_id = ${clientId} AND check_date = ${checkDate} LIMIT 1
  `))[0];
  if (checked) {
    return res.status(409).json({ error: "This machine already has a pre-start check for that day", code: "ALREADY_CHECKED" });
  }
  // A repeat mark for the same day keeps the first one.
  const inserted = rowsOf(await db.execute(sql`
    INSERT INTO green_machine_not_in_use (client_id, machine_id, check_date, reason, marked_by_name, created_by)
    VALUES (${clientId}, ${machineId}, ${checkDate}, ${reason || null}, ${req.currentUser!.name ?? null}, ${req.currentUser!.id})
    ON CONFLICT (machine_id, check_date) DO NOTHING
    RETURNING *
  `))[0];
  if (inserted) return res.status(201).json(inserted);
  const existing = rowsOf(await db.execute(sql`
    SELECT * FROM green_machine_not_in_use WHERE machine_id = ${machineId} AND client_id = ${clientId} AND check_date = ${checkDate}
  `))[0];
  res.status(200).json(existing);
});

// DELETE /green-track/pre-start/not-in-use/:id — the machine is in use after all
router.delete("/pre-start/not-in-use/:id", denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "Not found" });
  const deleted = rowsOf(await db.execute(sql`
    DELETE FROM green_machine_not_in_use WHERE id = ${id} AND client_id = ${clientId} RETURNING id
  `));
  if (deleted.length === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

export default router;
