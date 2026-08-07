import { Router } from "express";
import { db } from "@workspace/db";
import { premisesInspectionsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { requireAuth, denyViewers, getClientId } from "../middleware/requireAuth";
import { z } from "zod";

const router = Router();

// ── Summary ─────────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const today = new Date().toISOString().slice(0, 10);

  const [counts, overdue] = await Promise.all([
    db.select({
      status: premisesInspectionsTable.status,
      count:  sql<number>`count(*)::int`,
    })
      .from(premisesInspectionsTable)
      .where(eq(premisesInspectionsTable.clientId, clientId))
      .groupBy(premisesInspectionsTable.status),
    db.select({ count: sql<number>`count(*)::int` })
      .from(premisesInspectionsTable)
      .where(and(
        eq(premisesInspectionsTable.clientId, clientId),
        eq(premisesInspectionsTable.status, "open"),
        lte(premisesInspectionsTable.inspectionDate, today),
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
  inspectionType: z.enum(["routine", "hazard", "fault", "housekeeping", "signage"]).default("routine"),
  area:           z.string().optional().nullable(),
  findings:       z.string().optional().nullable(),
  hazardDetails:  z.string().optional().nullable(),
  actionRequired: z.string().optional().nullable(),
  actionTaken:    z.string().optional().nullable(),
  status:         z.enum(["open", "actioned", "closed"]).default("open"),
  inspectedBy:    z.string().optional().nullable(),
  siteId:         z.number().int().optional().nullable(),
});

// Ensure a provided siteId actually belongs to the caller's client. Returns
// true when there is nothing to check (no siteId) or the site is owned by the
// client; false on a cross-tenant mismatch.
async function siteBelongsToClient(siteId: number | null | undefined, clientId: number): Promise<boolean> {
  if (siteId == null) return true;
  const [site] = await db.select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)));
  return !!site;
}

router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { from, to, siteId, type, status } = req.query as Record<string, string>;
  const conds = [eq(premisesInspectionsTable.clientId, clientId)];
  if (from)   conds.push(gte(premisesInspectionsTable.inspectionDate, from));
  if (to)     conds.push(lte(premisesInspectionsTable.inspectionDate, to));
  if (siteId && !isNaN(parseInt(siteId, 10)))
    conds.push(eq(premisesInspectionsTable.siteId, parseInt(siteId, 10)));
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

  if (!(await siteBelongsToClient(d.siteId, clientId)))
    return res.status(400).json({ error: "Invalid siteId for this client" });

  const [row] = await db.insert(premisesInspectionsTable).values({
    clientId,
    siteId:         d.siteId ?? null,
    inspectionDate: d.inspectionDate,
    inspectionType: d.inspectionType,
    area:           d.area ?? null,
    findings:       d.findings ?? null,
    hazardDetails:  d.hazardDetails ?? null,
    actionRequired: d.actionRequired ?? null,
    actionTaken:    d.actionTaken ?? null,
    status:         d.status,
    inspectedBy:    d.inspectedBy ?? null,
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

  if (!(await siteBelongsToClient(d.siteId, clientId)))
    return res.status(400).json({ error: "Invalid siteId for this client" });

  await db.update(premisesInspectionsTable).set({
    siteId:         d.siteId ?? null,
    inspectionDate: d.inspectionDate,
    inspectionType: d.inspectionType,
    area:           d.area ?? null,
    findings:       d.findings ?? null,
    hazardDetails:  d.hazardDetails ?? null,
    actionRequired: d.actionRequired ?? null,
    actionTaken:    d.actionTaken ?? null,
    status:         d.status,
    inspectedBy:    d.inspectedBy ?? null,
    updatedAt:      new Date(),
  } as any).where(and(eq(premisesInspectionsTable.id, id), eq(premisesInspectionsTable.clientId, clientId)));
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  await db.delete(premisesInspectionsTable)
    .where(and(eq(premisesInspectionsTable.id, id), eq(premisesInspectionsTable.clientId, clientId)));
  res.json({ ok: true });
});

export default router;
