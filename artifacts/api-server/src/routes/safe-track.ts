import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  safeRiskAssessmentsTable,
  safeSopsTable,
  safeTrainingRecordsTable,
  safeInductionsTable,
  safeCompetencySignoffsTable,
  sitesTable,
} from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function allowedSites(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId))));
}

async function verifySite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return true;
  const [row] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!row;
}

function deptCondition(table: any, clientId: number, deptId: number | null) {
  if (deptId === null) return [];
  return [or(isNull(table.siteId), inArray(table.siteId, allowedSites(clientId, deptId))) as any];
}

function crudFor<T extends { clientId: number; siteId?: number | null }>(
  table: any,
  createSchema: z.ZodTypeAny,
  updateSchema: z.ZodTypeAny,
) {
  const sub = Router();

  sub.get("/", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const deptId = getActiveDepartmentId(req);
    const rows = await db.select().from(table)
      .where(and(eq(table.clientId, clientId), ...deptCondition(table, clientId, deptId)))
      .orderBy(desc(table.createdAt));
    res.json(rows);
  });

  sub.post("/", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const data = parsed.data as any;
    if (!(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
    const [row] = await db.insert(table).values({ ...data, clientId, createdBy: (req.session as any).userId ?? null }).returning();
    res.status(201).json(row);
  });

  sub.put("/:id", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const data = parsed.data as any;
    if ("siteId" in data && !(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
    const [row] = await db.update(table).set({ ...data, updatedAt: new Date() })
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });

  sub.delete("/:id", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [existing] = await db.select({ id: table.id }).from(table)
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });
    await db.delete(table).where(and(eq(table.id, id), eq(table.clientId, clientId)));
    res.status(204).end();
  });

  return sub;
}

// ── Risk Assessments ─────────────────────────────────────────────────────────

const raCreate = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  assessedBy: z.string().max(200).nullable().optional(),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(["draft", "published", "under_review"]).optional(),
  version: z.string().max(20).optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/risk-assessments", crudFor(safeRiskAssessmentsTable, raCreate, raCreate.partial()));

// ── SOPs ─────────────────────────────────────────────────────────────────────

const sopCreate = z.object({
  title: z.string().min(1).max(500),
  scope: z.string().max(1000).nullable().optional(),
  content: z.string().max(50000).nullable().optional(),
  version: z.string().max(20).optional(),
  publishedAt: z.string().datetime().nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/sops", crudFor(safeSopsTable, sopCreate, sopCreate.partial()));

// ── Training Records ─────────────────────────────────────────────────────────

const trCreate = z.object({
  staffName: z.string().min(1).max(200),
  trainingType: z.string().min(1).max(300),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/training-records", crudFor(safeTrainingRecordsTable, trCreate, trCreate.partial()));

// ── Inductions ───────────────────────────────────────────────────────────────

const indCreate = z.object({
  staffName: z.string().min(1).max(200),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  checklist: z.string().max(10000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/inductions", crudFor(safeInductionsTable, indCreate, indCreate.partial()));

// ── Competency Sign-offs ─────────────────────────────────────────────────────

const compCreate = z.object({
  staffName: z.string().min(1).max(200),
  taskName: z.string().min(1).max(300),
  signedOffBy: z.string().min(1).max(200),
  signedOffAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/competency", crudFor(safeCompetencySignoffsTable, compCreate, compCreate.partial()));

export default router;
