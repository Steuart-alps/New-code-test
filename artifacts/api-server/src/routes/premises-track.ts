import { Router } from "express";
import { db } from "@workspace/db";
import { premisesInspectionsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, gte, lte, lt, sql } from "drizzle-orm";
import { requireAuth, denyViewers, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { getEffectiveOptionList } from "../lib/formOptions";
import { resolveStaffPerformer, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import { z } from "zod";

const router = Router();

// Inspection dates are PostgreSQL DATE values, rather than instants. Validate
// them as calendar dates before they reach a comparison so the bounds retain
// their UK/date-picker meaning and cannot be widened by an invalid value.
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, "Invalid calendar date");

const listInspectionsQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  siteId: z.coerce.number().int().positive().optional(),
  type: z.string().min(1).max(60).optional(),
  status: z.enum(["open", "actioned", "closed"]).optional(),
}).refine(({ from, to }) => !from || !to || from <= to, {
  message: "'from' must not be after 'to'",
  path: ["to"],
});

function allowedSitesSubquery(clientId: number, departmentId: number) {
  return db.select({ id: sitesTable.id }).from(sitesTable).where(and(
    eq(sitesTable.clientId, clientId),
    or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId)),
  ));
}

function addDepartmentScope(conditions: any[], clientId: number, departmentId: number | null) {
  if (departmentId !== null) {
    conditions.push(or(
      isNull(premisesInspectionsTable.siteId),
      inArray(premisesInspectionsTable.siteId, allowedSitesSubquery(clientId, departmentId)),
    ));
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const today = new Date().toISOString().slice(0, 10);

  const conditions = [eq(premisesInspectionsTable.clientId, clientId)];
  addDepartmentScope(conditions, clientId, getActiveDepartmentId(req));
  const [counts, overdue] = await Promise.all([
    db.select({
      status: premisesInspectionsTable.status,
      count:  sql<number>`count(*)::int`,
    })
      .from(premisesInspectionsTable)
      .where(and(...conditions))
      .groupBy(premisesInspectionsTable.status),
    db.select({ count: sql<number>`count(*)::int` })
      .from(premisesInspectionsTable)
      .where(and(
        inArray(premisesInspectionsTable.status, ["open", "actioned"]),
        ...conditions,
        lt(premisesInspectionsTable.nextInspectionDate, today),
      )),
  ]);

  const byStatus: Record<string, number> = { open: 0, actioned: 0, closed: 0 };
  for (const row of counts) byStatus[row.status] = row.count;

  res.json({
    open:     byStatus.open ?? 0,
    actioned: byStatus.actioned ?? 0,
    closed:   byStatus.closed ?? 0,
    overdue:  overdue[0]?.count ?? 0,
    total:    (byStatus.open ?? 0) + (byStatus.actioned ?? 0) + (byStatus.closed ?? 0),
  });
});

// ── Inspections ───────────────────────────────────────────────────────────────

const InspectionBody = z.object({
  inspectionDate: z.string().min(1),
  nextInspectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  // Validated against the client's effective inspection-type list at request time.
  inspectionType: z.string().min(1).max(60).default("routine"),
  area:           z.string().optional().nullable(),
  findings:       z.string().optional().nullable(),
  hazardDetails:  z.string().optional().nullable(),
  actionRequired: z.string().optional().nullable(),
  actionTaken:    z.string().optional().nullable(),
  status:         z.enum(["open", "actioned", "closed"]).default("open"),
  inspectedBy:    z.string().optional().nullable(),
  staffRosterId:  z.number().int().positive().optional().nullable(),
  siteId:         z.number().int().optional().nullable(),
});

// Ensure a provided siteId actually belongs to the caller's client. Returns
// true when there is nothing to check (no siteId) or the site is owned by the
// client; false on a cross-tenant mismatch.
async function siteIsAccessible(siteId: number | null | undefined, clientId: number, departmentId: number | null): Promise<boolean> {
  if (siteId == null) return true;
  const conditions = [eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)];
  if (departmentId !== null) {
    conditions.push(or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId)) as any);
  }
  const [site] = await db.select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(...conditions));
  return !!site;
}

router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = listInspectionsQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid query parameters" });
  }
  const { from, to, siteId, type, status } = parsed.data;
  const departmentId = getActiveDepartmentId(req);
  // Do not turn an invalid/cross-scope site into an unfiltered export. This
  // check also makes the URL's site scope authoritative before querying rows.
  if (siteId !== undefined && !(await siteIsAccessible(siteId, clientId, departmentId))) {
    return res.status(403).json({ error: "Site is outside your access scope" });
  }

  const conds = [eq(premisesInspectionsTable.clientId, clientId)];
  addDepartmentScope(conds, clientId, departmentId);
  if (from)   conds.push(gte(premisesInspectionsTable.inspectionDate, from));
  if (to)     conds.push(lte(premisesInspectionsTable.inspectionDate, to));
  if (siteId !== undefined) conds.push(eq(premisesInspectionsTable.siteId, siteId));
  if (type)   conds.push(eq(premisesInspectionsTable.inspectionType, type));
  if (status) conds.push(eq(premisesInspectionsTable.status, status));

  const rows = await db.select().from(premisesInspectionsTable)
    .where(and(...conds))
    .orderBy(desc(premisesInspectionsTable.inspectionDate));
  res.json(rows);
});

router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const body = InspectionBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const d = body.data;
  const performer = await resolveStaffPerformer(clientId, d.staffRosterId, d.inspectedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });
  const allowedTypes = await getEffectiveOptionList(clientId, "premises_inspection_types");
  if (!allowedTypes.includes(d.inspectionType))
    return res.status(400).json({ error: "Invalid inspection type" });

  if (!(await siteIsAccessible(d.siteId, clientId, getActiveDepartmentId(req))))
    return res.status(400).json({ error: "Invalid siteId for this client" });

  const [row] = await db.insert(premisesInspectionsTable).values({
    clientId,
    siteId:         d.siteId ?? null,
    inspectionDate: d.inspectionDate,
    nextInspectionDate: d.nextInspectionDate ?? null,
    inspectionType: d.inspectionType,
    area:           d.area ?? null,
    findings:       d.findings ?? null,
    hazardDetails:  d.hazardDetails ?? null,
    actionRequired: d.actionRequired ?? null,
    actionTaken:    d.actionTaken ?? null,
    status:         d.status,
    inspectedBy:    performer.performedBy,
    staffRosterId:  performer.staffRosterId,
    createdBy:      (req as any).user?.id ?? null,
  } as any).returning();
  res.status(201).json(row);
});

router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = InspectionBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const d = body.data;
  // Allow a value unchanged from the stored record even if it is no longer in
  // the client's effective list; reject only NEW values not in the list.
  const [current] = await db.select({
    inspectionType: premisesInspectionsTable.inspectionType,
    siteId: premisesInspectionsTable.siteId,
    staffRosterId: premisesInspectionsTable.staffRosterId,
    inspectedBy: premisesInspectionsTable.inspectedBy,
  })
    .from(premisesInspectionsTable)
    .where(and(eq(premisesInspectionsTable.id, id), eq(premisesInspectionsTable.clientId, clientId))).limit(1);
  if (!current) return res.status(404).json({ error: "Not found" });
  const performer = await resolveStaffPerformerUpdate(clientId, d.staffRosterId, d.inspectedBy,
    current.staffRosterId, current.inspectedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });
  if (!(await siteIsAccessible(current.siteId, clientId, getActiveDepartmentId(req))))
    return res.status(403).json({ error: "Forbidden" });
  if (d.inspectionType !== current.inspectionType) {
    const allowedTypes = await getEffectiveOptionList(clientId, "premises_inspection_types");
    if (!allowedTypes.includes(d.inspectionType))
      return res.status(400).json({ error: "Invalid inspection type" });
  }

  if (!(await siteIsAccessible(d.siteId, clientId, getActiveDepartmentId(req))))
    return res.status(400).json({ error: "Invalid siteId for this client" });

  await db.update(premisesInspectionsTable).set({
    siteId:         d.siteId ?? null,
    inspectionDate: d.inspectionDate,
    nextInspectionDate: d.nextInspectionDate ?? null,
    inspectionType: d.inspectionType,
    area:           d.area ?? null,
    findings:       d.findings ?? null,
    hazardDetails:  d.hazardDetails ?? null,
    actionRequired: d.actionRequired ?? null,
    actionTaken:    d.actionTaken ?? null,
    status:         d.status,
    inspectedBy:    performer.performedBy,
    staffRosterId:  performer.staffRosterId,
    updatedAt:      new Date(),
  } as any).where(and(eq(premisesInspectionsTable.id, id), eq(premisesInspectionsTable.clientId, clientId)));
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [current] = await db.select({ siteId: premisesInspectionsTable.siteId })
    .from(premisesInspectionsTable)
    .where(and(eq(premisesInspectionsTable.id, id), eq(premisesInspectionsTable.clientId, clientId)))
    .limit(1);
  if (!current) return res.status(404).json({ error: "Not found" });
  if (!(await siteIsAccessible(current.siteId, clientId, getActiveDepartmentId(req))))
    return res.status(403).json({ error: "Forbidden" });
  await db.delete(premisesInspectionsTable)
    .where(and(eq(premisesInspectionsTable.id, id), eq(premisesInspectionsTable.clientId, clientId)));
  res.json({ ok: true });
});

export default router;
