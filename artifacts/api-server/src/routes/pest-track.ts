import { Router } from "express";
import { db } from "@workspace/db";
import { pestVisitsTable, pestActivityTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/requireAuth";
import { z } from "zod";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getClientId(req: any): number | null {
  const id = req.session?.clientId ?? req.user?.clientId ?? null;
  return typeof id === "number" ? id : null;
}

const CONFIG_KEYS = [
  "pest_contractor_name",
  "pest_contractor_company",
  "pest_visit_frequency_months",
  "pest_areas",
] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [visits, openActivity, visitsThisYear] = await Promise.all([
    db.select({
      id:              pestVisitsTable.id,
      visit_date:      pestVisitsTable.visitDate,
      next_visit_date: pestVisitsTable.nextVisitDate,
      contractor_name: pestVisitsTable.contractorName,
    })
      .from(pestVisitsTable)
      .where(eq(pestVisitsTable.clientId, clientId))
      .orderBy(desc(pestVisitsTable.visitDate))
      .limit(1),
    db.select({ count: sql<number>`count(*)::int` })
      .from(pestActivityTable)
      .where(and(
        eq(pestActivityTable.clientId, clientId),
        eq(pestActivityTable.resolved, false),
      )),
    db.select({ count: sql<number>`count(*)::int` })
      .from(pestVisitsTable)
      .where(and(
        eq(pestVisitsTable.clientId, clientId),
        gte(pestVisitsTable.visitDate, yearStart),
      )),
  ]);

  const lastVisit = visits[0] ?? null;

  res.json({
    last_visit_date:      lastVisit?.visit_date ?? null,
    last_contractor_name: lastVisit?.contractor_name ?? null,
    next_visit_date:      lastVisit?.next_visit_date ?? null,
    next_visit_overdue:   lastVisit?.next_visit_date ? lastVisit.next_visit_date < today : false,
    open_activity_count:  openActivity[0]?.count ?? 0,
    visits_this_year:     visitsThisYear[0]?.count ?? 0,
  });
});

// ── Contractor visits ─────────────────────────────────────────────────────────

const VisitBody = z.object({
  visitDate:          z.string().min(1),
  contractorName:     z.string().optional().nullable(),
  contractorCompany:  z.string().optional().nullable(),
  areasInspected:     z.string().optional().nullable(),
  findings:           z.string().optional().nullable(),
  treatmentsApplied:  z.string().optional().nullable(),
  recommendations:    z.string().optional().nullable(),
  nextVisitDate:      z.string().optional().nullable(),
  signedOffBy:        z.string().optional().nullable(),
  notes:              z.string().optional().nullable(),
  siteId:             z.number().int().optional().nullable(),
});

router.get("/visits", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.select().from(pestVisitsTable)
    .where(eq(pestVisitsTable.clientId, clientId))
    .orderBy(desc(pestVisitsTable.visitDate));
  res.json(rows);
});

router.post("/visits", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const body = VisitBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const d = body.data;

  const [row] = await db.insert(pestVisitsTable).values({
    clientId,
    siteId:            d.siteId ?? null,
    visitDate:         d.visitDate,
    contractorName:    d.contractorName ?? null,
    contractorCompany: d.contractorCompany ?? null,
    areasInspected:    d.areasInspected ?? null,
    findings:          d.findings ?? null,
    treatmentsApplied: d.treatmentsApplied ?? null,
    recommendations:   d.recommendations ?? null,
    nextVisitDate:     d.nextVisitDate ?? null,
    signedOffBy:       d.signedOffBy ?? null,
    notes:             d.notes ?? null,
    createdBy:         req.user?.id ?? null,
  } as any).returning();
  res.status(201).json(row);
});

router.put("/visits/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = VisitBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const d = body.data;

  await db.update(pestVisitsTable).set({
    siteId:            d.siteId ?? null,
    visitDate:         d.visitDate,
    contractorName:    d.contractorName ?? null,
    contractorCompany: d.contractorCompany ?? null,
    areasInspected:    d.areasInspected ?? null,
    findings:          d.findings ?? null,
    treatmentsApplied: d.treatmentsApplied ?? null,
    recommendations:   d.recommendations ?? null,
    nextVisitDate:     d.nextVisitDate ?? null,
    signedOffBy:       d.signedOffBy ?? null,
    notes:             d.notes ?? null,
    updatedAt:         new Date(),
  } as any).where(and(eq(pestVisitsTable.id, id), eq(pestVisitsTable.clientId, clientId)));
  res.json({ ok: true });
});

router.delete("/visits/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  await db.delete(pestVisitsTable)
    .where(and(eq(pestVisitsTable.id, id), eq(pestVisitsTable.clientId, clientId)));
  res.json({ ok: true });
});

// ── Pest activity log ─────────────────────────────────────────────────────────

const ActivityBody = z.object({
  recordedDate: z.string().min(1),
  pestType:     z.string().default("rodent"),
  evidenceType: z.string().default("live_sighting"),
  location:     z.string().optional().nullable(),
  severity:     z.string().default("low"),
  actionTaken:  z.string().optional().nullable(),
  recordedBy:   z.string().optional().nullable(),
  resolved:     z.boolean().optional(),
  notes:        z.string().optional().nullable(),
  siteId:       z.number().int().optional().nullable(),
});

router.get("/activity", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.select().from(pestActivityTable)
    .where(eq(pestActivityTable.clientId, clientId))
    .orderBy(desc(pestActivityTable.recordedDate));
  res.json(rows);
});

router.post("/activity", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const body = ActivityBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const d = body.data;

  const [row] = await db.insert(pestActivityTable).values({
    clientId,
    siteId:       d.siteId ?? null,
    recordedDate: d.recordedDate,
    pestType:     d.pestType,
    evidenceType: d.evidenceType,
    location:     d.location ?? null,
    severity:     d.severity,
    actionTaken:  d.actionTaken ?? null,
    recordedBy:   d.recordedBy ?? null,
    resolved:     d.resolved ?? false,
    notes:        d.notes ?? null,
    createdBy:    req.user?.id ?? null,
  } as any).returning();
  res.status(201).json(row);
});

router.put("/activity/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = ActivityBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const d = body.data;

  await db.update(pestActivityTable).set({
    siteId:       d.siteId ?? null,
    recordedDate: d.recordedDate,
    pestType:     d.pestType,
    evidenceType: d.evidenceType,
    location:     d.location ?? null,
    severity:     d.severity,
    actionTaken:  d.actionTaken ?? null,
    recordedBy:   d.recordedBy ?? null,
    resolved:     d.resolved ?? false,
    resolvedAt:   d.resolved ? new Date() : null,
    notes:        d.notes ?? null,
    updatedAt:    new Date(),
  } as any).where(and(eq(pestActivityTable.id, id), eq(pestActivityTable.clientId, clientId)));
  res.json({ ok: true });
});

router.delete("/activity/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  await db.delete(pestActivityTable)
    .where(and(eq(pestActivityTable.id, id), eq(pestActivityTable.clientId, clientId)));
  res.json({ ok: true });
});

// ── Config ────────────────────────────────────────────────────────────────────

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.select().from(appSettingsTable)
    .where(and(
      eq(appSettingsTable.clientId, clientId),
      sql`${appSettingsTable.key} = ANY(${CONFIG_KEYS})`,
    ));

  const config: Record<string, string> = {};
  for (const row of rows) config[row.key] = row.value ?? "";
  res.json(config);
});

router.put("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const updates: Record<string, string> = req.body ?? {};
  for (const [key, value] of Object.entries(updates)) {
    if (!CONFIG_KEYS.includes(key as ConfigKey)) continue;
    const existing = await db.select({ clientId: appSettingsTable.clientId })
      .from(appSettingsTable)
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)))
      .limit(1);
    if (existing.length > 0) {
      await db.update(appSettingsTable).set({ value: String(value), updatedAt: new Date() })
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
    } else {
      await db.insert(appSettingsTable).values({ clientId, key, value: String(value) });
    }
  }
  res.json({ ok: true });
});

export default router;
